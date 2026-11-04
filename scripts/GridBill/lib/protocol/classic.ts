/**
 * 协议里用到的其他算法：AES-256-ECB（登录 checkCode）、XXTEA 和 RSA（设备令牌）、
 * zlib 压缩（设备令牌）。Scripting 的 Crypto 只提供 AES-GCM，所以这些要自己写。
 */
import { concat, fromHex, md5Hex, randomBytes, toHex } from './bytes'

/* ---------- AES-256，只需要加密方向 ---------- */

const AES_SBOX = (() => {
  const box = new Uint8Array(256)
  const rotl8 = (x: number, n: number) => ((x << n) | (x >> (8 - n))) & 0xff
  let p = 1
  let q = 1
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff
    q ^= (q << 1) & 0xff
    q ^= (q << 2) & 0xff
    q ^= (q << 4) & 0xff
    if (q & 0x80) q ^= 0x09
    box[p] = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63
  } while (p !== 1)
  box[0] = 0x63
  return box
})()

function aes256RoundKeys(key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('AES-256 密钥必须是 32 字节')
  const keys = new Uint8Array(240)
  keys.set(key)
  let rcon = 1
  for (let i = 32; i < 240; i += 4) {
    let word = keys.slice(i - 4, i)
    if (i % 32 === 0) {
      word = Uint8Array.of(AES_SBOX[word[1]] ^ rcon, AES_SBOX[word[2]], AES_SBOX[word[3]], AES_SBOX[word[0]])
      rcon = (rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)
    } else if (i % 32 === 16) {
      word = word.map(byte => AES_SBOX[byte])
    }
    for (let j = 0; j < 4; j++) keys[i + j] = keys[i - 32 + j] ^ word[j]
  }
  return keys
}

const xtime = (x: number) => ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff

function aesEncryptBlock(block: Uint8Array, keys: Uint8Array): Uint8Array {
  let s = block.slice()
  const addKey = (round: number) => {
    for (let i = 0; i < 16; i++) s[i] ^= keys[round * 16 + i]
  }
  const subShift = () => {
    const t = s.map(byte => AES_SBOX[byte])
    s = Uint8Array.of(t[0], t[5], t[10], t[15], t[4], t[9], t[14], t[3], t[8], t[13], t[2], t[7], t[12], t[1], t[6], t[11])
  }
  addKey(0)
  for (let round = 1; round < 14; round++) {
    subShift()
    for (let c = 0; c < 16; c += 4) {
      const [a, b, d, e] = [s[c], s[c + 1], s[c + 2], s[c + 3]]
      const all = a ^ b ^ d ^ e
      s[c] = a ^ all ^ xtime(a ^ b)
      s[c + 1] = b ^ all ^ xtime(b ^ d)
      s[c + 2] = d ^ all ^ xtime(d ^ e)
      s[c + 3] = e ^ all ^ xtime(e ^ a)
    }
    addKey(round)
  }
  subShift()
  addKey(14)
  return s
}

export function aes256EcbEncrypt(plain: Uint8Array, key: Uint8Array): Uint8Array {
  const keys = aes256RoundKeys(key)
  const pad = 16 - (plain.length % 16)
  const padded = new Uint8Array(plain.length + pad)
  padded.set(plain)
  padded.fill(pad, plain.length)
  const out = new Uint8Array(padded.length)
  for (let i = 0; i < padded.length; i += 16) out.set(aesEncryptBlock(padded.subarray(i, i + 16), keys), i)
  return out
}

/* ---------- XXTEA，含 App 特有的“末尾写入长度”变体 ---------- */

export function xxteaEncrypt(plain: Uint8Array, keyBytes: Uint8Array): Uint8Array {
  if (plain.length === 0) return plain
  const material = keyBytes.length > 16 ? fromHex(md5Hex(keyBytes)) : keyBytes
  const keyBuffer = new Uint8Array(16)
  keyBuffer.set(material)
  const keyView = new DataView(keyBuffer.buffer)
  const key = [0, 1, 2, 3].map(i => keyView.getUint32(i * 4, true))

  const count = Math.floor(plain.length / 4) + (plain.length % 4 === 0 ? 1 : 2)
  const values = new Uint32Array(count)
  plain.forEach((byte, i) => {
    values[i >> 2] |= byte << ((i % 4) * 8)
  })
  values[count - 1] = plain.length

  const n = count - 1
  const mx = (sum: number, y: number, z: number, p: number, e: number) =>
    ((((z >>> 5) ^ (y << 2)) >>> 0) + (((y >>> 3) ^ (z << 4)) >>> 0)) ^
    (((y ^ sum) >>> 0) + ((z ^ key[(p & 3) ^ e]) >>> 0))

  let rounds = 6 + Math.floor(52 / (n + 1))
  let total = 0
  let z = values[n]
  while (rounds-- > 0) {
    total = (total + 0x9e3779b9) >>> 0
    const e = (total >>> 2) & 3
    for (let p = 0; p < n; p++) {
      values[p] = values[p] + mx(total, values[p + 1], z, p, e)
      z = values[p]
    }
    values[n] = values[n] + mx(total, values[0], z, n, e)
    z = values[n]
  }

  const out = new Uint8Array(count * 4)
  const outView = new DataView(out.buffer)
  values.forEach((value, i) => outView.setUint32(i * 4, value, true))
  return out
}

/* ---------- RSA PKCS#1 v1.5 公钥加密 ---------- */

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let b = base % modulus
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % modulus
    b = (b * b) % modulus
  }
  return result
}

export function rsaEncrypt(message: Uint8Array, modulusHex: string): Uint8Array {
  const size = modulusHex.length / 2
  const paddingLength = size - message.length - 3
  if (paddingLength < 8) throw new Error('RSA 明文过长')
  const padding = new Uint8Array(paddingLength)
  for (let filled = 0; filled < paddingLength; ) {
    for (const byte of randomBytes(paddingLength)) {
      if (byte !== 0 && filled < paddingLength) padding[filled++] = byte
    }
  }
  const encoded = concat(Uint8Array.of(0, 2), padding, Uint8Array.of(0), message)
  const cipher = modPow(BigInt('0x' + toHex(encoded)), 65537n, BigInt('0x' + modulusHex))
  return fromHex(cipher.toString(16).padStart(size * 2, '0'))
}

/* ---------- zlib：LZ77 + 固定哈夫曼 ---------- */

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

function symbolFor(table: number[], value: number): number {
  let index = table.length - 1
  while (table[index] > value) index--
  return index
}

/**
 * 令牌要放进 HTTP 请求头，不压缩会比上游大近一倍。
 * 原生 Data.compressed 的格式文档没有写明，所以这里用纯 JS，输出标准 zlib 流。
 */
export function zlibCompress(input: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x9c]
  let accumulator = 0
  let bitCount = 0
  const writeBits = (value: number, count: number) => {
    accumulator |= value << bitCount
    bitCount += count
    while (bitCount >= 8) {
      out.push(accumulator & 255)
      accumulator >>>= 8
      bitCount -= 8
    }
  }
  const writeCode = (code: number, count: number) => {
    let reversed = 0
    for (let i = 0; i < count; i++) reversed |= ((code >> i) & 1) << (count - 1 - i)
    writeBits(reversed, count)
  }
  const writeSymbol = (symbol: number) => {
    if (symbol < 144) writeCode(0x30 + symbol, 8)
    else if (symbol < 256) writeCode(0x190 + symbol - 144, 9)
    else if (symbol < 280) writeCode(symbol - 256, 7)
    else writeCode(0xc0 + symbol - 280, 8)
  }

  writeBits(1, 1) // BFINAL
  writeBits(1, 2) // 固定哈夫曼

  const head = new Int32Array(1 << 15).fill(-1)
  const previous = new Int32Array(input.length)
  const hashAt = (i: number) => ((input[i] << 10) ^ (input[i + 1] << 5) ^ input[i + 2]) & 0x7fff
  const insert = (i: number) => {
    if (i + 2 >= input.length) return
    const hash = hashAt(i)
    previous[i] = head[hash]
    head[hash] = i
  }

  for (let i = 0; i < input.length; ) {
    let bestLength = 0
    let bestDistance = 0
    if (i + 2 < input.length) {
      let candidate = head[hashAt(i)]
      for (let depth = 0; candidate >= 0 && i - candidate <= 32768 && depth < 128; depth++) {
        let length = 0
        while (length < 258 && i + length < input.length && input[candidate + length] === input[i + length]) length++
        if (length > bestLength) {
          bestLength = length
          bestDistance = i - candidate
        }
        candidate = previous[candidate]
      }
    }
    if (bestLength >= 3) {
      const lengthIndex = symbolFor(LENGTH_BASE, bestLength)
      writeSymbol(257 + lengthIndex)
      writeBits(bestLength - LENGTH_BASE[lengthIndex], LENGTH_EXTRA[lengthIndex])
      const distIndex = symbolFor(DIST_BASE, bestDistance)
      writeCode(distIndex, 5)
      writeBits(bestDistance - DIST_BASE[distIndex], DIST_EXTRA[distIndex])
      for (let k = 0; k < bestLength; k++) insert(i + k)
      i += bestLength
    } else {
      writeSymbol(input[i])
      insert(i)
      i++
    }
  }
  writeSymbol(256)
  if (bitCount > 0) out.push(accumulator & 255)

  let a = 1
  let b = 0
  for (const byte of input) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  out.push(b >>> 8, b & 255, a >>> 8, a & 255)
  return Uint8Array.from(out)
}
