'use strict'
// 模拟国网网关：真的解开信封、验证签名，再加密响应。不联网。
const assert = require('node:assert/strict')
const { lib } = require('./shim.cjs')
const { fromHex, toHex, utf8Decode, utf8Encode, randomBytes } = lib('protocol/bytes')
const { sm2Decrypt, sm2Encrypt, sm2PublicKey, sm3Hex, sm4DecryptEcb, sm4EncryptEcb } = lib('protocol/gm')
const { API_BASE } = lib('protocol/client')

const SERVER_PRIVATE = '1'.repeat(64)
const CLIENT_PRIVATE = '2'.repeat(64)

const TEST_KEYS = { serverPublicKey: sm2PublicKey(SERVER_PRIVATE), clientPrivateKey: CLIENT_PRIVATE }
const CLIENT_PUBLIC = sm2PublicKey(CLIENT_PRIVATE)

const ok = data => ({ code: '1', data: { srvrt: { resultCode: '0000', resultMessage: '成功' }, ...data } })
const fail = (code, message = '失败') => ({ code: '1', data: { srvrt: { resultCode: code, resultMessage: message } } })

const defaults = {
  login: () =>
    ok({
      bizrt: {
        token: 'token-1',
        tokenExpireTime: 1296000,
        userInfo: {
          userId: 'user-1',
          addressProvince: '110000',
          powerUserList: [
            { id: 'acct-1', powerUserNo: 'enc-1', powerUserNo_dst: '1100001234', proNo: '11102', orgNo: '111', elecType: '01', consName: '张*', elecAddr: '不应被保存的地址' },
            { id: 'acct-2', powerUserNo: 'enc-2', powerUserNo_dst: '1100005678', proNo: '11102', orgNo: '111', elecType: '01', consName: '李*' },
          ],
        },
      },
    }),
  smsLogin: () => defaults.login(),
  sms: () => ok({ bizrt: { codeKey: 'code-key-1' } }),
  daily: payload => {
    const start = payload.data.startTime
    if (start.startsWith('2026-11')) {
      return ok({
        totalPq: '30.5',
        sevenEleList: [
          { day: '20261102', dayElePq: '10.5', thisAmt: '5.2' },
          { day: '2026-11-01', dayElePq: '20' },
          { day: '20261103', dayElePq: '-' },
        ],
      })
    }
    return ok({ totalPq: '300', sevenEleList: [{ day: '20261030', dayElePq: '12' }, { day: '20261031', dayElePq: '8' }] })
  },
  monthly: () =>
    ok({
      yearPq: '2000',
      yearAmt: '1100.5',
      list: [
        { month: '202608', monthPq: '280', monthAmt: '150' },
        { month: '202609', monthPq: '305', monthAmt: '198.25', eleList: [{ endDate: '20260930', pq: '305', amt: '198.25' }] },
      ],
    }),
  balance: () => ok({ list: [{ consType: '1', sumMoney: '88.35', prepayBal: '88.35', historyOwe: '0' }] }),
}

const ROUTES = {
  'emss-uia-center-front/member/c2/f01': 'login',
  'emss-uia-center-front/member/c2/f02': 'smsLogin',
  'emss-uia-center-front/member/c1/f01': 'sms',
  'emss-bia-bill-front/member/c11/f01': 'daily',
  'emss-bia-bill-front/member/c51/f04': 'monthly',
  'emss-bia-balance-front/member/c16/f01': 'balance',
}

function createMockServer(overrides = {}) {
  const handlers = { ...defaults, ...overrides }
  const requests = []
  const server = {
    handlers,
    requests,
    count: name => requests.filter(r => r.route === name).length,
    transport: async (url, request) => {
      assert.ok(url.startsWith(API_BASE), `请求了白名单之外的地址：${url}`)
      const route = ROUTES[url.slice(API_BASE.length)]
      assert.ok(route, `未知接口：${url}`)
      const envelope = JSON.parse(request.body)
      assert.deepEqual(Object.keys(envelope), ['data', 'sign', 'skey', 'timestamp'])
      assert.equal(envelope.sign, sm3Hex(envelope.skey + envelope.data + envelope.timestamp), '签名不匹配')
      assert.match(envelope.skey, /^04[0-9a-f]+$/)
      assert.match(envelope.data, /^[0-9A-F]+$/)
      const keyText = utf8Decode(sm2Decrypt(envelope.skey, SERVER_PRIVATE))
      assert.match(keyText, /^[0-9a-f]{32}$/)
      const payload = JSON.parse(utf8Decode(sm4DecryptEcb(fromHex(envelope.data), utf8Encode(keyText.slice(0, 16)))))
      requests.push({ route, payload, headers: request.headers })

      const response = await handlers[route](payload, request.headers)
      if (response && response.rawStatus) return { status: response.rawStatus, text: response.text ?? '' }
      const responseKey = toHex(randomBytes(16))
      return {
        status: 200,
        text: JSON.stringify({
          respKey: sm2Encrypt(utf8Encode(responseKey), CLIENT_PUBLIC),
          encryptData: toHex(sm4EncryptEcb(utf8Encode(JSON.stringify(response)), utf8Encode(responseKey.slice(0, 16)))).toUpperCase(),
        }),
      }
    },
  }
  return server
}

module.exports = { createMockServer, TEST_KEYS, ok, fail }
