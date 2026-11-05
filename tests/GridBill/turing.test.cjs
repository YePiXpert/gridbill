'use strict'
// 设备令牌：上游测试向量 + 按 JCE 规范独立解码，检查结构和上游一致。
const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('node:zlib')
const { lib } = require('./support/shim.cjs')

const { toHex, utf8Encode, utf8Decode } = lib('protocol/bytes')
const turing = lib('protocol/turing')
const { TURING_RSA_MODULUS, STABLE_NATIVE_FEATURES } = lib('protocol/turing-data')

const TIMESTAMP = 1_750_000_000_000
const STATE = {
  seedHex: toHex(Uint8Array.from({ length: 32 }, (_, i) => i)),
  bootAt: 1_749_913_600_000,
  installAt: 1_749_000_000_000,
}

test('hash64 匹配上游从原生库抓到的向量', () => {
  assert.equal(turing.turingHash64(utf8Encode('ABCDE72347517')), 0x707628991401630dn)
})

test('特征哈希标签匹配上游向量', () => {
  assert.deepEqual(turing.featureHashTags(['A', 'B', 'C', 'D', 'E'], TIMESTAMP), ['01707628991401630d', '707628991401630d'])
})

test('hash64 处理各种尾部长度不抛错且结果在 64 位内', () => {
  for (let length = 0; length < 20; length++) {
    const value = turing.turingHash64(new Uint8Array(length).fill(0xab))
    assert.ok(value >= 0n && value < 1n << 64n)
  }
})

function decodeJce(bytes) {
  let i = 0
  const readHead = () => {
    const first = bytes[i++]
    let tag = first >> 4
    if (tag === 15) tag = bytes[i++]
    return { tag, type: first & 15 }
  }
  const readValue = type => {
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    switch (type) {
      case 0: return view.getInt8(i++)
      case 1: { const v = view.getInt16(i); i += 2; return v }
      case 2: { const v = view.getInt32(i); i += 4; return v }
      case 3: { const v = view.getBigInt64(i); i += 8; return Number(v) }
      case 6: { const n = bytes[i++]; const v = utf8Decode(bytes.subarray(i, i + n)); i += n; return v }
      case 7: { const n = view.getInt32(i); i += 4; const v = utf8Decode(bytes.subarray(i, i + n)); i += n; return v }
      case 8: {
        const size = readValue(readHead().type)
        const entries = []
        for (let k = 0; k < size; k++) {
          const key = readValue(readHead().type)
          const value = readValue(readHead().type)
          entries.push([key, value])
        }
        return entries
      }
      case 10: {
        const fields = {}
        for (;;) {
          const head = readHead()
          if (head.type === 11) return fields
          fields[head.tag] = readValue(head.type)
        }
      }
      case 12: return 0
      default: throw new Error(`未知 JCE 类型 ${type}`)
    }
  }
  const fields = {}
  while (i < bytes.length) {
    const head = readHead()
    fields[head.tag] = readValue(head.type)
  }
  return fields
}

test('m90 结构和上游 serialize_m90_full 一致', () => {
  const nonce = 'n'.repeat(32)
  const m90 = turing.buildM90(STATE, TIMESTAMP, nonce)
  // 上游测试：m90 长度应在 3700–4100 字节之间
  assert.ok(m90.length >= 3700 && m90.length <= 4100, `m90 长度 ${m90.length}`)

  const top = decodeJce(m90)
  assert.deepEqual(top[0], [[2, 'sdk_gphone64_arm64'], [1, 'google'], [3, '10000191'], [4, 'com.sgcc.wsgw.cn']])
  assert.equal(top[1], TIMESTAMP)
  assert.equal(top[2], 1)
  assert.equal(top[5], -22056)
  assert.equal(top[6], '-22056')
  assert.equal(top[7], nonce)

  const nested = top[4]
  assert.equal(nested[0], TIMESTAMP)
  assert.deepEqual(nested[1], { 0: 90, 1: '90', 2: '77F2B17A00A92C71', 3: '10000191', 4: 2 })
  assert.deepEqual(nested[3], { 0: '3.2.3,113', 1: 'com.sgcc.wsgw.cn' })
  assert.deepEqual(nested[6], [[2, '']])
  assert.deepEqual(nested[8], { 0: '', 2: '', 3: 0, 4: '', 5: '' })

  const features = nested[2]
  assert.equal(features.length, 62, '上游要求 62 个原生特征')
  assert.deepEqual(features.map(([k]) => k), [...features.map(([k]) => k)].sort((a, b) => a - b), '必须按键升序')
  const map = new Map(features)
  assert.equal(map.get(107), 'com.sgcc.wsgw.cn_DAB5608ECD1ABEF80E5FA277CF3B8D50')
  assert.equal(map.get(126), String(STATE.bootAt))
  assert.match(map.get(34), new RegExp(`^C:1,T:${TIMESTAMP},LT:\\d+$`))
  assert.match(map.get(16), /^[0-9a-f]{16}$/)
  assert.match(map.get(148), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(map.get(125).split(',').length, 7)
  for (const [key, value] of Object.entries(STABLE_NATIVE_FEATURES)) assert.equal(map.get(Number(key)), value)

  const direct = new Map(nested[5])
  assert.deepEqual(nested[5].map(([k]) => k), [3, 8, 9, 7, 10, 12, 4], '顺序与上游一致')
  assert.match(direct.get(3), /^5_1_-22056_\d{4}_\d{4}_\d{4}$/)
  const uid = map.get(17).split(':')[2]
  assert.equal(direct.get(7), `com.sgcc.wsgw.cn:tools,${uid},untrusted_app,${uid},,init`)
  const [tag10, tag12] = turing.featureHashTags(features.map(([, v]) => v), TIMESTAMP)
  assert.equal(direct.get(10), tag10)
  assert.equal(direct.get(12), tag12)
  assert.equal(tag10, '01' + tag12)
  // 30 个 Java 指标 + 29 个原生指标
  assert.equal(direct.get(4).split(',').length, 59)
})

test('同一设备身份稳定，请求相关字段随时间变化（与上游测试一致）', () => {
  const features = at => new Map(decodeJce(turing.buildM90(STATE, at, 'x'.repeat(32)))[4][2])
  const a = features(TIMESTAMP)
  const b = features(TIMESTAMP + 3_600_000)
  for (const key of [16, 17, 26, 126, 129, 141, 148]) assert.equal(a.get(key), b.get(key), `特征 ${key} 应该稳定`)
  assert.notEqual(a.get(34), b.get(34))
  assert.notEqual(a.get(125), b.get(125))
})

test('不同种子得到不同设备', () => {
  const other = { ...STATE, seedHex: 'ff'.repeat(32) }
  assert.notEqual(turing.appGuid(STATE.seedHex), turing.appGuid(other.seedHex))
  assert.match(turing.appGuid(STATE.seedHex), /^[A-Za-z0-9]{60}$/)
})

test('令牌能完整还原，且比“只存储不压缩”小得多', () => {
  const m90 = turing.buildM90(STATE, TIMESTAMP, 'n'.repeat(32))
  const key = utf8Encode('0123456789abcdef')
  const token = turing.encodeToken(m90, key)
  assert.ok(token.startsWith('v3:'))
  const packed = Buffer.from(token.slice(3), 'base64')
  assert.equal(packed[0], 1)
  const cipher = packed.subarray(257)
  assert.equal(cipher.length % 4, 0)
  // XXTEA 解密复用 crypto.test 的逻辑
  const plain = xxteaDecrypt(new Uint8Array(cipher), key)
  const inflated = zlib.inflateSync(plain)
  assert.equal(inflated[0], 2)
  assert.deepEqual(Buffer.from(inflated.subarray(1)), Buffer.from(m90))
  const storedSize = Math.ceil(((1 + 256 + m90.length + 20) * 4) / 3)
  console.log(`令牌长度 ${token.length} 字符；不压缩约 ${storedSize} 字符；上游约 2800–3100 字符`)
  assert.ok(token.length < 4000, `令牌长度 ${token.length}`)
})

test('RSA 模数是 2048 位', () => {
  assert.equal(TURING_RSA_MODULUS.length, 512)
  assert.equal(BigInt('0x' + TURING_RSA_MODULUS).toString(2).length, 2048)
})

test('设备令牌缓存 4 小时，过期才重新生成', () => {
  const state = turing.createDeviceState(TIMESTAMP)
  assert.ok(state.bootAt < TIMESTAMP - 3_600_000 + 1)
  assert.ok(state.installAt < state.bootAt)
  const first = turing.withFreshToken(state, TIMESTAMP)
  assert.notEqual(first, state)
  assert.equal(first.token.time, String(TIMESTAMP).slice(0, 10))
  assert.equal(turing.withFreshToken(first, TIMESTAMP + 3_600_000), first, '未过期应复用')
  assert.notEqual(turing.withFreshToken(first, TIMESTAMP + 4 * 3_600_000 + 1), first, '过期应重新生成')
  assert.notEqual(turing.withFreshToken(first, TIMESTAMP - 1), first, '时钟回拨时不信任缓存')
})

function xxteaDecrypt(cipher, keyBytes) {
  const keyView = new DataView(keyBytes.buffer, keyBytes.byteOffset, 16)
  const key = [0, 1, 2, 3].map(i => keyView.getUint32(i * 4, true))
  const view = new DataView(cipher.buffer, cipher.byteOffset, cipher.length)
  const v = new Uint32Array(cipher.length / 4).map((_, i) => view.getUint32(i * 4, true))
  const n = v.length - 1
  const mx = (sum, y, z, p, e) => (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((y ^ sum) + (z ^ key[(p & 3) ^ e]))
  const rounds = 6 + Math.floor(52 / (n + 1))
  let sum = Math.imul(rounds, 0x9e3779b9) >>> 0
  let y = v[0]
  for (let r = 0; r < rounds; r++) {
    const e = (sum >>> 2) & 3
    for (let p = n; p > 0; p--) y = v[p] = (v[p] - mx(sum, y, v[p - 1], p, e)) >>> 0
    y = v[0] = (v[0] - mx(sum, y, v[n], 0, e)) >>> 0
    sum = (sum - 0x9e3779b9) >>> 0
  }
  const length = v[n]
  const out = new Uint8Array(n * 4)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < n; i++) outView.setUint32(i * 4, v[i], true)
  return out.subarray(0, length)
}
