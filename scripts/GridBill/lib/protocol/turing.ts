/**
 * 网上国网 App 3.2.3 的设备令牌（deviceTokenTX）。
 *
 * 算法移植自 hass-state-grid（MIT）的 turing 模块，详见 NOTICE.md。
 * 令牌描述的是一台由随机种子派生的虚拟安卓设备，不读取、也不发送 iPhone 的任何真实信息。
 * 这个模块只照搬上游协议，不做任何规避风控的改动。
 */
import { rsaEncrypt, xxteaEncrypt, zlibCompress } from './classic'
import { base64, concat, fromHex, hmacSha256, randomBelow, randomBytes, randomString, toHex, utf8Encode } from './bytes'
import { STABLE_NATIVE_FEATURES, TURING_RSA_MODULUS } from './turing-data'

const PACKAGE = 'com.sgcc.wsgw.cn'
const CHANNEL = '10000191'
const BUILD_MARKER = '77F2B17A00A92C71'
const BRAND = 'google'
export const DEVICE_MODEL = 'sdk_gphone64_arm64'
const STATUS_CODE = -22056
const TOKEN_TTL_MS = 4 * 3600 * 1000
const DAY_MS = 86_400_000
const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export type DeviceToken = { value: string; time: string; issuedAt: number }
export type DeviceState = { seedHex: string; bootAt: number; installAt: number; token?: DeviceToken }

const JAVA_TIMING_ORDER: Array<number | string> = [133, 138, 140, -17, 17, 145, 146, 149, 22, 150, 151, 24, 100, 101, 102, 103, 104, 105, 106, 107, 44, 113, 114, 115, 116, 117, 118, 120, 122, 's9']
const JAVA_TIMING_REFERENCE: Record<string, number> = { '133': 0, '138': 1, '140': 0, '-17': 0, '17': 1, '145': 0, '146': 0, '149': 0, '22': 1, '150': 0, '151': 0, '24': 0, '100': 6, '101': 114, '102': 0, '103': 0, '104': 0, '105': 0, '106': 3, '107': 0, '44': 0, '113': 2, '114': 1, '115': 1, '116': 0, '117': 0, '118': 0, '120': 8, '122': 0, s9: 1 }
const NATIVE_TIMING_ORDER = [21, 7, 10, 14, 33, 11, 24, 12, 23, 8, 13, 25, 20, 35, 42, 121, 135, 124, 125, 129, 131, 134, 132, 137, 142, 141, 9, 15, 16]
const NATIVE_TIMING_REFERENCE: Record<number, number> = { 21: 1, 7: 0, 10: 3, 14: 0, 33: 0, 11: 0, 24: 0, 12: 0, 23: 0, 8: 0, 13: 0, 25: 0, 20: 0, 35: 0, 42: 0, 121: 1, 135: 2, 124: 0, 125: 0, 129: 0, 131: 0, 134: 0, 132: 0, 137: 1, 142: 0, 141: 0, 9: 16, 15: 0, 16: 0 }
/** sign, kind, owner（null 表示 App 的 uid）, 三个固定字段, 指标位数 */
const PROCESS_TEMPLATES: Array<[number, number, number | null, number, number, number, number]> = [
  [-1, 3, 1000, 17, 0, 438, 3],
  [-1, 1, 0, 20, 0, 493, 3],
  [1, 1, 1000, 1864, 1036632, 420, 2],
  [-1, 1, 0, 20, 0, 493, 2],
  [1, 3, 1000, 17, 0, 438, 3],
  [1, 1, null, 19, 0, 292, 6],
  [-1, 1, null, 19, 0, 292, 6],
]

/* ---------- 由种子确定性派生的虚拟设备 ---------- */

class Profile {
  private readonly seed: Uint8Array
  constructor(seedHex: string) {
    this.seed = fromHex(seedHex)
    if (this.seed.length !== 32) throw new Error('设备种子必须是 32 字节')
  }

  bytes(label: string, size = 32): Uint8Array {
    const prefix = concat(utf8Encode('wsgw-turing-profile-v1\0'), utf8Encode(label))
    const out = new Uint8Array(size)
    for (let counter = 0, offset = 0; offset < size; counter++, offset += 32) {
      const suffix = new Uint8Array(4)
      new DataView(suffix.buffer).setUint32(0, counter)
      out.set(hmacSha256(this.seed, concat(prefix, suffix)).subarray(0, Math.min(32, size - offset)), offset)
    }
    return out
  }

  hex(label: string, size = 16): string {
    return toHex(this.bytes(label, size))
  }

  bigInteger(label: string, lower: bigint, upper: bigint): bigint {
    return lower + BigInt('0x' + this.hex(label, 8)) % (upper - lower + 1n)
  }

  integer(label: string, lower: number, upper: number): number {
    return Number(this.bigInteger(label, BigInt(lower), BigInt(upper)))
  }

  requestInteger(label: string, timestamp: number, lower: number, upper: number): number {
    return this.integer(`request:${timestamp}:${label}`, lower, upper)
  }

  uuid(label: string): string {
    const v = this.bytes(label, 16)
    v[6] = (v[6] & 0x0f) | 0x40
    v[8] = (v[8] & 0x3f) | 0x80
    const h = toHex(v)
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }

  timing(label: string, timestamp: number, reference: number): number {
    if (reference <= 0) return 0
    const radius = Math.max(1, Math.floor(reference / 4))
    const digits = String(reference).length
    const lower = digits > 1 ? 10 ** (digits - 1) : 0
    const upper = 10 ** digits - 1
    return this.requestInteger(`timing:${label}`, timestamp, Math.max(lower, reference - radius), Math.min(upper, reference + radius))
  }

  performanceContext(timestamp: number): string {
    const java = JAVA_TIMING_ORDER.map(f => `${f}_${this.timing(String(f), timestamp, JAVA_TIMING_REFERENCE[String(f)])}`)
    const native = NATIVE_TIMING_ORDER.map(f => `${f}_${this.timing(`native-${f}`, timestamp, NATIVE_TIMING_REFERENCE[f])}`)
    return [...java, ...native].join(',')
  }
}

function nativeFeatures(profile: Profile, state: DeviceState, now: number): Array<[number, string]> {
  const uid = profile.integer('uid', 10000, 19999)
  const installA = base64(profile.bytes('install-a', 16), true)
  const installB = base64(profile.bytes('install-b', 16), true).replace(/=+$/, '') + '='
  const installContext =
    `1:1:${uid}:${state.installAt}:${PACKAGE}::${profile.integer('install-slot', 100_000_000, 999_999_999)}:app/~~${installA}/-${installB},`

  const processes = PROCESS_TEMPLATES.map(([sign, kind, owner, a, b, c, digits], index) => {
    const magnitude = profile.bigInteger(`process-hash-${index}`, 1_000_000_000_000_000_000n, 9_000_000_000_000_000_000n)
    const metric = profile.requestInteger(`process-metric-${index}`, now, 10 ** (digits - 1), 10 ** digits - 1)
    return `${magnitude * BigInt(sign)}:${kind}:${owner ?? uid}_${a}_${b}_${c}_${metric}`
  })

  const interfaceId = profile.hex('interface-id', 3)
  const address = `5054:ff:fe${interfaceId.slice(0, 2)}:${interfaceId.slice(2)}`
  const network = `8,eth0;69699;3;fe80::${address};fec0::${address};10.0.2.15,dummy0;65731;1;fe80::8c95:a4ff:fe59:322`

  const values = new Map<number, string>(
    Object.entries(STABLE_NATIVE_FEATURES).map(([key, value]) => [Number(key), value]),
  )
  values.set(16, profile.hex('android-id', 8))
  values.set(17, installContext)
  values.set(26, profile.hex('native-device-id', 16))
  values.set(34, `C:1,T:${now},LT:${profile.requestInteger('collection-latency', now, 8000, 16000)}`)
  values.set(125, processes.join(','))
  values.set(126, String(state.bootAt))
  values.set(129, network)
  values.set(141, String(profile.integer('native-property-141', 1_000_000, 9_999_999)))
  values.set(146, '1,272494655,eth0,10.0.2.15,10.0.2.3')
  values.set(148, profile.uuid('oaid'))
  if (values.size !== 62) throw new Error(`设备特征数量异常：${values.size}`)
  return [...values.entries()].sort((a, b) => a[0] - b[0])
}

/* ---------- 特征哈希 ---------- */

const MASK_64 = (1n << 64n) - 1n
const HASH_MULTIPLIER = 0xc6a4a7935bd1e995n
const mix47 = (value: bigint) => value ^ (value >> 47n)

export function turingHash64(data: Uint8Array): bigint {
  const blocks = data.length >> 3
  let state = (BigInt(data.length) * HASH_MULTIPLIER) & MASK_64
  for (let i = 0; i < blocks; i++) {
    let word = 0n
    for (let j = 7; j >= 0; j--) word = (word << 8n) | BigInt(data[i * 8 + j])
    word = (mix47((word * HASH_MULTIPLIER) & MASK_64) * HASH_MULTIPLIER) & MASK_64
    state = ((word ^ state) * HASH_MULTIPLIER) & MASK_64
  }
  const tail = data.subarray(blocks * 8)
  if (tail.length >= 7) state ^= BigInt(tail[6]) << 48n
  if (tail.length >= 6) state ^= BigInt(tail[5]) << 40n
  if (tail.length >= 5) state ^= BigInt(tail[4]) << 32n
  if (tail.length >= 4) state ^= BigInt(tail[3]) << 24n
  if (tail.length >= 3) state ^= BigInt(tail[2]) << 16n
  // 这个奇怪的 AND 来自原生实现，上游测试向量依赖它。
  if (tail.length >= 2) state ^= 0x118727c03fb9ffc6n & (BigInt(tail[1]) << 8n)
  if (tail.length >= 1) {
    state ^= BigInt(tail[0])
    state = (state * HASH_MULTIPLIER) & MASK_64
  }
  state = mix47(state)
  state = (state * HASH_MULTIPLIER) & MASK_64
  return mix47(state)
}

/** 返回 [tag10, tag12]。 */
export function featureHashTags(values: string[], timestamp: number): [string, string] {
  const parts = [...values]
  let state = BigInt(timestamp)
  for (let i = 0; i < Math.floor((values.length + 3) / 4); i++) {
    state = ((state * 214013n + 2531011n) >> 16n) & 0x7fffn
    parts.push(state.toString(16))
  }
  const digest = turingHash64(utf8Encode(parts.join(''))).toString(16)
  return ['01' + digest, digest]
}

/* ---------- JCE/Tars 写入器 ---------- */

const JceType = { Byte: 0, Short: 1, Int: 2, Long: 3, String1: 6, String4: 7, Map: 8, StructBegin: 10, StructEnd: 11, Zero: 12 }

class JceWriter {
  private readonly bytes: number[] = []

  private head(tag: number, type: number): void {
    if (tag < 15) this.bytes.push((tag << 4) | type)
    else this.bytes.push(0xf0 | type, tag)
  }

  int(tag: number, value: number): void {
    if (value === 0) {
      this.head(tag, JceType.Zero)
    } else if (value >= -128 && value <= 127) {
      this.head(tag, JceType.Byte)
      this.bytes.push(value & 0xff)
    } else if (value >= -32768 && value <= 32767) {
      this.head(tag, JceType.Short)
      this.bytes.push((value >> 8) & 0xff, value & 0xff)
    } else if (value >= -2147483648 && value <= 2147483647) {
      this.head(tag, JceType.Int)
      this.bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
    } else {
      this.head(tag, JceType.Long)
      let rest = BigInt.asUintN(64, BigInt(value))
      const big: number[] = []
      for (let i = 0; i < 8; i++) {
        big.unshift(Number(rest & 0xffn))
        rest >>= 8n
      }
      this.bytes.push(...big)
    }
  }

  string(tag: number, value: string): void {
    const raw = utf8Encode(value)
    if (raw.length <= 255) {
      this.head(tag, JceType.String1)
      this.bytes.push(raw.length)
    } else {
      this.head(tag, JceType.String4)
      const n = raw.length
      this.bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
    }
    for (const byte of raw) this.bytes.push(byte)
  }

  map(tag: number, entries: Array<[number, string]>): void {
    this.head(tag, JceType.Map)
    this.int(0, entries.length)
    for (const [key, value] of entries) {
      this.int(0, key)
      this.string(1, value)
    }
  }

  struct(tag: number, fields: Uint8Array): void {
    this.head(tag, JceType.StructBegin)
    for (const byte of fields) this.bytes.push(byte)
    this.head(0, JceType.StructEnd)
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

/* ---------- 组装令牌 ---------- */

/** 令牌明文（m90）。导出是为了离线测试它的结构。 */
export function buildM90(state: DeviceState, timestamp: number, nonce: string): Uint8Array {
  const profile = new Profile(state.seedHex)
  const features = nativeFeatures(profile, state, timestamp)
  const [tag10, tag12] = featureHashTags(features.map(([, value]) => value), timestamp)
  const uid = profile.integer('uid', 10000, 19999)
  const stages = [0, 1, 2].map(i => profile.requestInteger(`stage-${i}`, timestamp, 1000, 2200))

  const meta = new JceWriter()
  meta.int(0, 90)
  meta.string(1, '90')
  meta.string(2, BUILD_MARKER)
  meta.string(3, CHANNEL)
  meta.int(4, 2)

  const network = new JceWriter()
  network.string(0, '3.2.3,113')
  network.string(1, PACKAGE)

  const tail = new JceWriter()
  tail.string(0, '')
  tail.string(2, '')
  tail.int(3, 0)
  tail.string(4, '')
  tail.string(5, '')

  const nested = new JceWriter()
  nested.int(0, timestamp)
  nested.struct(1, meta.finish())
  nested.map(2, features)
  nested.struct(3, network.finish())
  nested.map(5, [
    [3, `5_1_${STATUS_CODE}_${stages.join('_')}`],
    [8, '1'],
    [9, ''],
    [7, `${PACKAGE}:tools,${uid},untrusted_app,${uid},,init`],
    [10, tag10],
    [12, tag12],
    [4, profile.performanceContext(timestamp)],
  ])
  nested.map(6, [[2, '']])
  nested.struct(8, tail.finish())

  const top = new JceWriter()
  top.map(0, [[2, DEVICE_MODEL], [1, BRAND], [3, CHANNEL], [4, PACKAGE]])
  top.int(1, timestamp)
  top.int(2, 1)
  top.struct(4, nested.finish())
  top.int(5, STATUS_CODE)
  top.string(6, String(STATUS_CODE))
  top.string(7, nonce)
  return top.finish()
}

/** key 只在测试时传入。 */
export function encodeToken(m90: Uint8Array, key: Uint8Array = utf8Encode(randomString(16, ALNUM))): string {
  if (key.length !== 16) throw new Error('令牌密钥必须是 16 字节')
  const compressed = zlibCompress(concat(Uint8Array.of(2), m90))
  const packed = concat(Uint8Array.of(1), rsaEncrypt(key, TURING_RSA_MODULUS), xxteaEncrypt(compressed, key))
  return 'v3:' + base64(packed)
}

/* ---------- 设备状态 ---------- */

export function createDeviceState(now: number): DeviceState {
  const bootAt = now - randomBelow(DAY_MS * 14 - 3_600_000) - 3_600_000
  return {
    seedHex: toHex(randomBytes(32)),
    bootAt,
    installAt: bootAt - randomBelow(DAY_MS * 180 - DAY_MS) - DAY_MS,
  }
}

/** 令牌缓存 4 小时；没过期时返回同一个对象，调用方可据此判断要不要写回。 */
export function withFreshToken(state: DeviceState, now: number): DeviceState {
  const age = state.token ? now - state.token.issuedAt : -1
  if (age >= 0 && age <= TOKEN_TTL_MS) return state
  const nonce = randomString(32, ALNUM)
  return {
    ...state,
    token: { value: encodeToken(buildM90(state, now, nonce)), time: String(now).slice(0, 10), issuedAt: now },
  }
}

export function appGuid(seedHex: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from(new Profile(seedHex).bytes('app-guid', 60), value => alphabet[value % alphabet.length]).join('')
}
