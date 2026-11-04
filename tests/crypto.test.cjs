'use strict'
// 加密算法：和 OpenSSL（Node 内置）做独立交叉验证，再加上游公开的已知向量。
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { lib } = require('./support/shim.cjs')

const { fromHex, toHex, utf8Decode, utf8Encode, base64, md5Hex, randomString } = lib('protocol/bytes')
const gm = lib('protocol/gm')
const classic = lib('protocol/classic')
const client = lib('protocol/client')

const hex = buffer => Buffer.from(buffer).toString('hex')

test('UTF-8 编解码支持中文和 emoji', () => {
  for (const text of ['', 'abc', '国网电费', '⚡️电费', '𠮷野家']) {
    assert.deepEqual(Buffer.from(utf8Encode(text)), Buffer.from(text, 'utf8'))
    assert.equal(utf8Decode(Buffer.from(text, 'utf8')), text)
  }
})

test('Base64 与 Node 一致', () => {
  for (const length of [0, 1, 2, 3, 16, 31, 32, 33, 100]) {
    const data = crypto.randomBytes(length)
    assert.equal(base64(data), data.toString('base64'))
    assert.equal(base64(data, true), data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_'))
  }
})

test('randomString 只产生字母表内的字符且长度正确', () => {
  const s = randomString(500, 'abc')
  assert.equal(s.length, 500)
  assert.match(s, /^[abc]+$/)
  assert.ok(new Set(s).size === 3)
})

test('SM3 与 OpenSSL 一致（含国标向量）', () => {
  assert.equal(toHex(gm.sm3(utf8Encode('abc'))), '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0')
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
    const data = crypto.randomBytes(length)
    assert.equal(toHex(gm.sm3(data)), crypto.createHash('sm3').update(data).digest('hex'), `长度 ${length}`)
  }
})

test('SM4-ECB 与 OpenSSL 互通（含国标向量）', () => {
  const key = fromHex('0123456789abcdeffedcba9876543210')
  const standard = gm.sm4EncryptEcb(key, key).subarray(0, 16)
  assert.equal(toHex(standard), '681edf34d206965e86b3e94f536e4246')
  for (const length of [0, 1, 15, 16, 17, 100]) {
    const data = crypto.randomBytes(length)
    const openssl = crypto.createCipheriv('sm4-ecb', key, null)
    const expected = Buffer.concat([openssl.update(data), openssl.final()])
    assert.equal(hex(gm.sm4EncryptEcb(data, key)), expected.toString('hex'), `加密长度 ${length}`)
    assert.equal(hex(gm.sm4DecryptEcb(expected, key)), data.toString('hex'), `解密长度 ${length}`)
  }
})

test('SM4 拒绝无效密文', () => {
  const key = new Uint8Array(16)
  assert.throws(() => gm.sm4DecryptEcb(new Uint8Array(0), key))
  assert.throws(() => gm.sm4DecryptEcb(new Uint8Array(15), key))
})

test('SM2 点乘与 OpenSSL 的 SM2 曲线一致', () => {
  for (let i = 0; i < 5; i++) {
    const ecdh = crypto.createECDH('SM2')
    ecdh.generateKeys()
    const privateKey = ecdh.getPrivateKey('hex').padStart(64, '0')
    assert.equal(gm.sm2PublicKey(privateKey), ecdh.getPublicKey('hex').slice(2))
  }
})

test('SM2 密文能被独立实现解开：KDF、C3、C1C3C2 格式都符合国标', () => {
  // OpenSSL 不允许在 SM2 曲线上做 ECDH，所以这里用一套独立的仿射坐标点乘（和产品代码的雅可比坐标完全不同），
  // 哈希用 OpenSSL 的 SM3。
  const P = BigInt('0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFF')
  const A = P - 3n
  const mod = v => ((v % P) + P) % P
  const inv = v => {
    let [a, b, x, y] = [mod(v), P, 1n, 0n]
    while (b) {
      const q = a / b
      ;[a, b, x, y] = [b, a - q * b, y, x - q * y]
    }
    return mod(x)
  }
  const add = (p, q) => {
    if (!p) return q
    if (!q) return p
    if (p[0] === q[0] && mod(p[1] + q[1]) === 0n) return null
    const l = p[0] === q[0] ? mod((3n * p[0] * p[0] + A) * inv(2n * p[1])) : mod((q[1] - p[1]) * inv(q[0] - p[0]))
    const x = mod(l * l - p[0] - q[0])
    return [x, mod(l * (p[0] - x) - p[1])]
  }
  const mul = (k, point) => {
    let r = null
    for (let n = point; k > 0n; k >>= 1n, n = add(n, n)) if (k & 1n) r = add(r, n)
    return r
  }

  const receiver = crypto.createECDH('SM2')
  receiver.generateKeys()
  const d = BigInt('0x' + receiver.getPrivateKey('hex'))
  for (const text of ['0123456789abcdef0123456789abcdef', 'x', 'a'.repeat(70)]) {
    const cipher = gm.sm2Encrypt(utf8Encode(text), receiver.getPublicKey('hex'))
    assert.match(cipher, /^04[0-9a-f]+$/)
    const body = cipher.slice(2)
    const c1 = [BigInt('0x' + body.slice(0, 64)), BigInt('0x' + body.slice(64, 128))]
    const c3 = body.slice(128, 192)
    const c2 = Buffer.from(body.slice(192), 'hex')
    assert.equal(c2.length, text.length)

    const [x, y] = mul(d, c1)
    const x2 = Buffer.from(x.toString(16).padStart(64, '0'), 'hex')
    const y2 = Buffer.from(y.toString(16).padStart(64, '0'), 'hex')
    const blocks = []
    for (let counter = 1; blocks.length * 32 < c2.length; counter++) {
      blocks.push(crypto.createHash('sm3').update(x2).update(y2).update(Buffer.from([0, 0, 0, counter])).digest())
    }
    const mask = Buffer.concat(blocks)
    const plain = Buffer.from(c2.map((byte, i) => byte ^ mask[i]))
    assert.equal(plain.toString(), text)
    assert.equal(crypto.createHash('sm3').update(x2).update(plain).update(y2).digest('hex'), c3, 'C3 校验未通过')
  }

  // 反过来：用独立实现按国标构造的密文，产品代码也要能解开。
  const k = 0x1234567890abcdefn
  const G = [BigInt('0x32C4AE2C1F1981195F9904466A39C9948FE30BBFF2660BE1715A4589334C74C7'), BigInt('0xBC3736A2F4F6779C59BDCEE36B692153D0A9877CC62A474002DF32E52139F0A0')]
  const hex64 = v => v.toString(16).padStart(64, '0')
  const c1 = mul(k, G)
  const [sx, sy] = mul(k, mul(d, G))
  const seed = Buffer.from(hex64(sx) + hex64(sy), 'hex')
  const mask = crypto.createHash('sm3').update(seed).update(Buffer.from([0, 0, 0, 1])).digest()
  const message = Buffer.from('bdb70549e6a0428880bbb7dd766de085')
  const c2 = Buffer.from(message.map((byte, i) => byte ^ mask[i]))
  const c3 = crypto.createHash('sm3').update(Buffer.from(hex64(sx), 'hex')).update(message).update(Buffer.from(hex64(sy), 'hex')).digest('hex')
  const wire = '04' + hex64(c1[0]) + hex64(c1[1]) + c3 + c2.toString('hex')
  assert.equal(utf8Decode(gm.sm2Decrypt(wire, receiver.getPrivateKey('hex'))), message.toString())
})

test('SM2 自身加解密往返，并拒绝不在曲线上的点', () => {
  const privateKey = 'a'.repeat(64)
  const publicKey = gm.sm2PublicKey(privateKey)
  const text = 'bdb70549e6a0428880bbb7dd766de085'
  assert.equal(utf8Decode(gm.sm2Decrypt(gm.sm2Encrypt(utf8Encode(text), publicKey), privateKey)), text)
  assert.throws(() => gm.sm2Encrypt(utf8Encode('x'), '0'.repeat(128)))
  assert.throws(() => gm.sm2Decrypt('04' + '0'.repeat(128), privateKey))
})

test('真实服务器公钥是合法的 SM2 点', () => {
  assert.doesNotThrow(() => gm.sm2Encrypt(utf8Encode('x'), client.APP_KEYS.serverPublicKey))
})

test('AES-256-ECB 与 OpenSSL 一致', () => {
  const key = crypto.randomBytes(32)
  for (const length of [0, 1, 15, 16, 17, 64]) {
    const data = crypto.randomBytes(length)
    const openssl = crypto.createCipheriv('aes-256-ecb', key, null)
    const expected = Buffer.concat([openssl.update(data), openssl.final()])
    assert.equal(hex(classic.aes256EcbEncrypt(data, key)), expected.toString('hex'))
  }
})

test('checkCode 匹配上游测试向量', () => {
  assert.equal(
    client.generateCheckCode('11111111111', 1700000000000, '000001234567890123456789'),
    '000001234567890123456789' + '75632da3be842c1e29f4ea7a72e06ca4' + '6cbe56b5abe93c05f5866135498093e4',
  )
})

test('密码 MD5 匹配上游测试向量', () => {
  assert.equal(md5Hex('test-password'), 'dfb450efddbb5387197c84460623675b')
  assert.equal(md5Hex('中文密码'), crypto.createHash('md5').update('中文密码').digest('hex'))
})

test('zlib 输出能被标准库解开，并且真的有压缩', () => {
  const samples = [new Uint8Array(0), utf8Encode('a'), utf8Encode('abcabcabcabc'), crypto.randomBytes(1000), utf8Encode('tmpfs:/dev:tmpfs:rw&seclabel&nosuid&relatime,'.repeat(100)), new Uint8Array(70000).fill(7)]
  for (const sample of samples) {
    const compressed = classic.zlibCompress(sample)
    assert.deepEqual(Buffer.from(zlib.inflateSync(compressed)), Buffer.from(sample))
  }
  const text = utf8Encode('tmpfs:/dev:tmpfs:rw&seclabel&nosuid&relatime,'.repeat(100))
  assert.ok(classic.zlibCompress(text).length < text.length / 10)
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
    for (let p = n; p > 0; p--) {
      y = v[p] = (v[p] - mx(sum, y, v[p - 1], p, e)) >>> 0
    }
    y = v[0] = (v[0] - mx(sum, y, v[n], 0, e)) >>> 0
    sum = (sum - 0x9e3779b9) >>> 0
  }
  const length = v[n]
  const out = new Uint8Array((v.length - 1) * 4)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < n; i++) outView.setUint32(i * 4, v[i], true)
  return out.subarray(0, length)
}

test('XXTEA 可被标准解密还原，长度字段写在末尾', () => {
  const key = utf8Encode('0123456789abcdef')
  for (const length of [1, 3, 4, 5, 8, 100, 2500]) {
    const plain = crypto.randomBytes(length)
    const cipher = classic.xxteaEncrypt(plain, key)
    assert.equal(cipher.length % 4, 0)
    assert.equal(hex(xxteaDecrypt(cipher, key)), plain.toString('hex'), `长度 ${length}`)
  }
})

test('RSA PKCS#1 v1.5 能被私钥解开', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const modulus = Buffer.from(publicKey.export({ format: 'jwk' }).n, 'base64url').toString('hex')
  const message = utf8Encode('0123456789abcdef')
  const cipher = classic.rsaEncrypt(message, modulus)
  assert.equal(cipher.length, 256)
  const block = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, cipher)
  assert.equal(block[0], 0)
  assert.equal(block[1], 2)
  const separator = block.indexOf(0, 2)
  assert.ok(separator >= 10, '填充至少 8 字节且不含 0')
  assert.equal(block.subarray(separator + 1).toString(), '0123456789abcdef')
})
