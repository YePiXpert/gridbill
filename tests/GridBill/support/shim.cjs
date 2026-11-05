'use strict'
// 在 Node 里模拟 Scripting 的全局 API，让 lib/ 下的代码原样运行。
const crypto = require('node:crypto')

class FakeData {
  constructor(bytes) {
    this.bytes = Uint8Array.from(bytes)
  }
  static fromUint8Array(bytes) {
    return new FakeData(bytes)
  }
  toUint8Array() {
    return this.bytes.slice()
  }
}

const keychain = new Map()
const storage = new Map()

globalThis.Data = FakeData
globalThis.Crypto = {
  generateSymmetricKey: (bits = 256) => new FakeData(crypto.randomBytes(bits / 8)),
  md5: data => new FakeData(crypto.createHash('md5').update(data.toUint8Array()).digest()),
  hmacSHA256: (data, key) => new FakeData(crypto.createHmac('sha256', key.toUint8Array()).update(data.toUint8Array()).digest()),
}
globalThis.Keychain = {
  get: key => (keychain.has(key) ? keychain.get(key) : null),
  set: (key, value) => (keychain.set(key, value), true),
  remove: key => (keychain.delete(key), true),
  contains: key => keychain.has(key),
  keys: () => [...keychain.keys()],
  clear: () => (keychain.clear(), true),
}
globalThis.Storage = {
  get: key => (storage.has(key) ? JSON.parse(storage.get(key)) : null),
  set: (key, value) => (storage.set(key, JSON.stringify(value)), true),
  remove: key => void storage.delete(key),
  clear: () => storage.clear(),
}

module.exports = {
  keychain,
  storage,
  resetStores() {
    keychain.clear()
    storage.clear()
  },
  lib: path => require(`../../../.build/GridBill/lib/${path}`),
}
