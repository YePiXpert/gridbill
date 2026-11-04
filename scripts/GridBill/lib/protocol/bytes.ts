/**
 * 字节与编码工具。
 *
 * 随机数、MD5、HMAC 用 Scripting 原生的 Crypto / Data，其余都是纯 JS。
 * 不依赖 TextEncoder、btoa、node:crypto：官方文档说明它们在小组件里不保证可用。
 */

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) as number
    // 单独出现的代理项无法编码，按惯例换成 U+FFFD。
    const cp = code >= 0xd800 && code <= 0xdfff ? 0xfffd : code
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return Uint8Array.from(out)
}

export function utf8Decode(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; ) {
    const lead = bytes[i++]
    const extra = lead < 0x80 ? 0 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3
    let cp = extra === 0 ? lead : lead & (0x3f >> extra)
    for (let k = 0; k < extra; k++) cp = (cp << 6) | (bytes[i++] & 63)
    parts.push(String.fromCodePoint(cp))
  }
  return parts.join('')
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('无效的十六进制字符串')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 带填充的 Base64；urlSafe 只替换字符，保留填充，与上游 urlsafe_b64encode 一致。 */
export function base64(bytes: Uint8Array, urlSafe = false): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += BASE64[a >> 2]
    out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : BASE64[c & 63]
  }
  return urlSafe ? out.replace(/\+/g, '-').replace(/\//g, '_') : out
}

function toData(bytes: Uint8Array): Data {
  const data = Data.fromUint8Array(bytes)
  if (!data) throw new Error('无法创建 Data')
  return data
}

function fromData(data: Data): Uint8Array {
  const bytes = data.toUint8Array()
  if (!bytes) throw new Error('无法读取 Data')
  return bytes
}

export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size)
  for (let offset = 0; offset < size; offset += 32) {
    const chunk = fromData(Crypto.generateSymmetricKey(256))
    out.set(chunk.subarray(0, Math.min(32, size - offset)), offset)
  }
  return out
}

/** [0, max) 内的随机整数，max 不超过 2^48；这里只用于生成设备时间，偏差可忽略。 */
export function randomBelow(max: number): number {
  const bytes = randomBytes(6)
  let value = 0
  for (const byte of bytes) value = value * 256 + byte
  return value % max
}

/** 拒绝采样，保证每个字符等概率。 */
export function randomString(length: number, alphabet: string): string {
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length]
    }
  }
  return out
}

export function md5Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? utf8Encode(input) : input
  return toHex(fromData(Crypto.md5(toData(bytes))))
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return fromData(Crypto.hmacSHA256(toData(message), toData(key)))
}
