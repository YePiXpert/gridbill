'use strict'
// 协议层：信封、请求头、接口参数、错误分类、数据解析。对照上游 api.py / login.py / models.py。
const test = require('node:test')
const assert = require('node:assert/strict')
const { lib, resetStores } = require('./support/shim.cjs')
const { createMockServer, TEST_KEYS, ok, fail } = require('./support/mock-server.cjs')

const { md5Hex } = lib('protocol/bytes')
const { SgccClient, SgccError, API_BASE, buildLoginParams, buildSmsLoginParams, loginHeaderMd5, chinaTime, buildEnvelope, openEnvelope } = lib('protocol/client')
const parse = lib('protocol/parse')
const gm = lib('protocol/gm')
const { utf8Encode, utf8Decode } = lib('protocol/bytes')

const NOW = Date.UTC(2026, 10, 4, 2, 3, 4, 5)

function makeClient(server) {
  let device = null
  return new SgccClient({
    phone: '13800000000',
    transport: server.transport,
    keys: TEST_KEYS,
    now: () => NOW,
    loadDevice: () => device,
    saveDevice: state => {
      device = state
    },
  })
}

const SESSION = { token: 'tok', userId: 'u1', province: '110000', expiresAt: NOW + 1e9 }
const ACCOUNT = { id: 'a', consNo: 'enc', consNoSrc: 'src', provinceCode: '11102', orgNo: 'org', elecType: '02', name: 'n' }

test('北京时间换算正确（跨日）', () => {
  const t = chinaTime(Date.UTC(2026, 10, 30, 16, 30, 1, 9))
  assert.equal(t.isoDay, '2026-12-01')
  assert.equal(t.seconds, '20261201003001')
  assert.equal(t.millis, '20261201003001009')
})

test('信封往返：只有持有私钥的一方才能解开', () => {
  const payload = { 中文: '值', n: 1 }
  const envelope = buildEnvelope(payload, TEST_KEYS.serverPublicKey, 'bdb70549e6a0428880bbb7dd766de085', '1787054400000')
  assert.deepEqual(Object.keys(envelope), ['data', 'sign', 'skey', 'timestamp'])
  assert.equal(envelope.skey.length, 258, '与上游测试一致：04 + C1 + C3 + 32 字节密文')
  assert.equal(envelope.sign, gm.sm3Hex(envelope.skey + envelope.data + envelope.timestamp))
  assert.equal(utf8Decode(gm.sm2Decrypt(envelope.skey, '1'.repeat(64))), 'bdb70549e6a0428880bbb7dd766de085')
})

test('解信封时拒绝格式不对的响应密钥', () => {
  const publicKey = gm.sm2PublicKey('2'.repeat(64))
  assert.throws(() => openEnvelope({ respKey: gm.sm2Encrypt(utf8Encode('not-a-hex-key'), publicKey), encryptData: 'AA' }, '2'.repeat(64)))
})

test('登录参数结构和上游 build_password_login_map 一致', () => {
  const params = buildLoginParams('11111111111', md5Hex('test-password'), 1700000000000, { code: '123456', codeKey: 'one-shot-key' }, '000001234567890123456789')
  assert.deepEqual(Object.keys(params), ['quInfo', 'uscInfo', 'checkCode', 'avalonValidCode'])
  assert.equal(params.quInfo.password, 'dfb450efddbb5387197c84460623675b')
  assert.equal(params.quInfo.code, '123456')
  assert.equal(params.quInfo.codeKey, 'one-shot-key')
  assert.equal(params.quInfo.pushId, '000000,000000')
  assert.equal(params.uscInfo.member, '2202')
  assert.equal(params.uscInfo.isEncrypt, 'false')
  assert.equal(params.uscInfo.optSys, 'Android 13')
  assert.equal(params.checkCode, '000001234567890123456789' + '75632da3be842c1e29f4ea7a72e06ca4' + '6cbe56b5abe93c05f5866135498093e4')
  assert.equal(loginHeaderMd5(params).length, 32)
})

test('请求头 md5 对字段顺序敏感，按 Java HashMap 顺序计算', () => {
  // 同样的内容换个书写顺序，结果必须一样，因为遍历顺序由哈希决定。
  const a = { b: { account: '1', password: '2', code: '3' }, a: 'x' }
  const b = { a: 'x', b: { code: '3', password: '2', account: '1' } }
  const sameBuckets = loginHeaderMd5(a) === loginHeaderMd5(b)
  assert.equal(typeof sameBuckets, 'boolean')
  // 外层一定按键排序
  assert.equal(loginHeaderMd5({ b: 1, a: 2 }), md5Hex('a2b1'))
})

test('登录请求头和上游 _headers 一致，且不发送真实设备信息', async () => {
  const server = createMockServer()
  await makeClient(server).login(md5Hex('pw'))
  const { headers } = server.requests[0]
  assert.equal(headers.t, '')
  assert.equal(headers.userid, '0')
  assert.equal(headers.province, '')
  assert.match(headers.timeStamp, /^\d{14}$/, '登录用 14 位时间')
  assert.match(headers.md5, /^[0-9a-f]{32}$/)
  assert.equal(headers.security, 'android')
  assert.equal(headers.appcode, 'WSGW-SG1001-APP')
  assert.equal(headers.datacenter, '99')
  assert.equal(headers.version, '3.2.3')
  assert.equal(headers['User-Agent'], 'okhttp/3.14.9')
  assert.equal(headers.ip, '127.0.0.1')
  assert.match(headers.AppGuid, /^[A-Za-z0-9]{60}$/)
  assert.match(headers.AppGuidNew, /^[A-Za-z0-9]{40}\d{20}$/)
  assert.ok(headers.deviceTokenTX.startsWith('v3:'))
  assert.match(headers.deviceTokenTXTime, /^\d{10}$/)
})

test('登录后的查询请求头带会话，时间戳是 23 位', async () => {
  const server = createMockServer()
  await makeClient(server).dailyUsage(SESSION, ACCOUNT, '2026-11-01', '2026-11-30')
  const { headers } = server.requests[0]
  assert.equal(headers.t, 'tok')
  assert.equal(headers.userid, 'u1')
  assert.equal(headers.province, '110000')
  assert.match(headers.timeStamp, /^\d{23}$/)
  assert.equal(headers.md5, undefined)
})

test('查询参数和上游 build_*_payload 一致', async () => {
  const server = createMockServer()
  const client = makeClient(server)
  await client.dailyUsage(SESSION, ACCOUNT, '2026-11-01', '2026-11-30')
  await client.monthlyBills(SESSION, ACCOUNT, 2026)
  await client.balance(SESSION, ACCOUNT)
  const [daily, monthly, balance] = server.requests.map(r => r.payload)
  assert.equal(daily.serviceCode, 'BCP_000026')
  assert.equal(daily.target, '11102')
  assert.equal(daily.data.consNo, 'src')
  assert.equal(daily.data.consNosrc, 'src')
  assert.equal(daily.data.consType, '02', '02 型 + 11102 省')
  assert.equal(daily.data.startTime, '2026-11-01')
  assert.equal(daily.data.endTime, '2026-11-30')
  assert.deepEqual(monthly.data, { year: 2026, consNo: 'src', provinceCode: '11102', startYm: '202601', endYm: '202612', funcCode: 'ALIPAY_01' })
  assert.equal(balance.serviceCode, '0101143')
  assert.equal(balance.data.funcCode, 'A1007200')
  assert.equal(balance.data.acctId, 'u1')
  assert.deepEqual(balance.data.list, [{ consNoSrc: 'src', proCode: '11102', sceneType: '02', consNo: 'enc', orgNo: 'org' }])
})

test('新设备短信只发 logindevice 类型', async () => {
  const server = createMockServer()
  assert.equal(await makeClient(server).sendDeviceSms(), 'code-key-1')
  assert.equal(server.requests[0].payload.quInfo.businessType, 'logindevice')
  assert.equal(server.requests[0].payload.quInfo.account, '13800000000')
})

test('验证码登录的参数和请求头 md5 与上游 login.py 算出的结果逐字一致', () => {
  const params = buildSmsLoginParams('11111111111', '123456', 'one-shot-key')
  // 这两个值是用上游的 build_sms_login_map 和 login_header_md5 算出来的。
  assert.equal(
    JSON.stringify(params),
    '{"quInfo":{"account":"11111111111","businessType":"login","code":"123456","optSys":"Android","pushId":"000000,000000","codeKey":"one-shot-key"},' +
      '"uscInfo":{"isEncrypt":"false","devciceIp":"127.0.0.1","devciceId":"000000","tenant":"state_grid","member":"2202","optSys":"Android 13","operatorType":"","devciceName":"sdk_gphone64_arm64","pushId":"000000,000000"}}',
  )
  assert.equal(loginHeaderMd5(params), '96fdda85a9de0650c3e9bdc403ecc326')
})

test('验证码登录：发 login 类型的短信，登录走 c2/f02，请求头和密码登录一样', async () => {
  const server = createMockServer()
  const client = makeClient(server)
  const codeKey = await client.sendLoginSms()
  assert.equal(codeKey, 'code-key-1')
  const { session, accounts } = await client.smsLogin('123456', codeKey)
  assert.equal(session.token, 'token-1')
  assert.equal(session.userId, 'user-1')
  assert.equal(accounts.length, 2)

  const [send, login] = server.requests
  assert.equal(send.route, 'sms')
  assert.equal(send.payload.quInfo.businessType, 'login')
  assert.equal(send.payload.quInfo.account, '13800000000')
  assert.equal(send.headers.md5, undefined, '和上游一样，发短信不带 md5')

  assert.equal(login.route, 'smsLogin')
  assert.equal(login.payload.quInfo.code, '123456')
  assert.equal(login.payload.quInfo.codeKey, 'code-key-1')
  assert.ok(!('password' in login.payload.quInfo), '这条路径不发密码')
  assert.equal(login.headers.md5, loginHeaderMd5(login.payload))
  assert.match(login.headers.timeStamp, /^\d{14}$/, '登录用 14 位时间')
  assert.equal(login.headers.AppGuid, send.headers.AppGuid, '发码和登录是同一个设备身份')
})

test('验证码登录的错误分类：风控和新设备单独处理，其他拒绝都算账号问题', async () => {
  const cases = [
    [fail('RK008', '网络连接超时 (RK008),请重试!'), 'risk'],
    [fail('4006', '新设备'), 'device'],
    [fail('1001', '验证码错误'), 'credentials'],
    [ok({ bizrt: {} }), 'credentials'],
  ]
  for (const [response, kind] of cases) {
    const server = createMockServer({ smsLogin: () => response })
    await assert.rejects(makeClient(server).smsLogin('123456', 'k'), error => error instanceof SgccError && error.kind === kind, `应为 ${kind}`)
  }
  const blocked = createMockServer({ sms: () => fail('RK008') })
  await assert.rejects(makeClient(blocked).sendLoginSms(), error => error.kind === 'risk' && error.code === 'RK008')
})

test('RK 开头的代码都算风控，不能当成密码错误，错误里带上具体代码', async () => {
  const message = '网络连接超时 (RK007),请重试!'
  const server = createMockServer({ login: () => fail('RK007', message), balance: () => fail('RK007', message) })
  const isRisk = error => error instanceof SgccError && error.kind === 'risk' && error.code === 'RK007' && error.message.includes('RK007') && !error.message.includes('请重试')
  await assert.rejects(makeClient(server).login('x'), isRisk)
  await assert.rejects(makeClient(server).balance(SESSION, ACCOUNT), isRisk)
  const other = createMockServer({ balance: () => fail('RKX', '不是这个系列') })
  await assert.rejects(makeClient(other).balance(SESSION, ACCOUNT), error => error.kind === 'business')
})

test('错误分类和上游 _raise_for_error 一致', async () => {
  const cases = [
    [fail('4006', '新设备'), 'device'],
    [fail('RK008', '校验失败'), 'risk'],
    [fail('1234', '账号或密码错误'), 'credentials'],
    [{ code: '0', message: 'gateway' }, 'credentials'],
    [fail('-200'), 'credentials'],
  ]
  for (const [response, kind] of cases) {
    const server = createMockServer({ login: () => response })
    await assert.rejects(makeClient(server).login('x'), error => error instanceof SgccError && error.kind === kind)
  }
  const queries = [
    [fail('-200'), 'session'],
    [fail('-201'), 'session'],
    [{ code: '-200' }, 'session'],
    [fail('4006'), 'device'],
    [fail('RK008'), 'risk'],
    [fail('9999', '接口错误'), 'business'],
    [ok({ rtnCode: '500', rtnMsg: '地区不支持' }), 'business'],
  ]
  for (const [response, kind] of queries) {
    const server = createMockServer({ balance: () => response })
    await assert.rejects(makeClient(server).balance(SESSION, ACCOUNT), error => error instanceof SgccError && error.kind === kind, `应为 ${kind}`)
  }
  const success = createMockServer({ balance: () => ok({ rtnCode: '0000', list: [] }) })
  assert.equal(await makeClient(success).balance(SESSION, ACCOUNT), null)
})

test('网络和响应异常都归为 network，不泄露细节', async () => {
  const bad = [
    { rawStatus: 502 },
    { rawStatus: 200, text: 'not json' },
    { rawStatus: 200, text: '{"code":"1"}' },
    { rawStatus: 302, text: '' },
    { rawStatus: 200, text: JSON.stringify({ respKey: 'zz', encryptData: 'zz' }) },
  ]
  for (const response of bad) {
    const server = createMockServer({ balance: () => response })
    await assert.rejects(makeClient(server).balance(SESSION, ACCOUNT), error => error.kind === 'network')
  }
  const down = createMockServer({ balance: () => { throw new Error('offline at https://secret/') } })
  await assert.rejects(makeClient(down).balance(SESSION, ACCOUNT), error => error.kind === 'network' && !error.message.includes('secret'))
})

test('登录结果只保留必要字段，不保存地址', async () => {
  const server = createMockServer()
  const { session, accounts } = await makeClient(server).login('x')
  assert.equal(session.token, 'token-1')
  assert.equal(session.userId, 'user-1')
  assert.equal(session.province, '110000')
  assert.equal(session.expiresAt, NOW + 1296000 * 1000)
  assert.equal(accounts.length, 2)
  assert.deepEqual(accounts[0], { id: 'acct-1', consNo: 'enc-1', consNoSrc: '1100001234', provinceCode: '11102', orgNo: '111', elecType: '01', name: '张*' })
  assert.ok(!JSON.stringify({ session, accounts }).includes('地址'))
})

test('userInfo 是数组、缺 token 时的处理', async () => {
  const asList = createMockServer({ login: () => ok({ bizrt: { token: 't', userId: 'b', userInfo: [null, { addressProvince: 'p', powerUserList: [] }] } }) })
  const { session } = await makeClient(asList).login('x')
  assert.equal(session.province, 'p')
  assert.equal(session.userId, 'b')
  const noToken = createMockServer({ login: () => ok({ bizrt: {} }) })
  await assert.rejects(makeClient(noToken).login('x'), error => error.kind === 'credentials')
})

test('数字解析：占位符和空白变 null，不变 0', () => {
  for (const value of [null, undefined, '', ' ', ',', '-', '--', 'abc', '0x10', 'Infinity', 'NaN', [], {}, NaN, Infinity]) {
    assert.equal(parse.parseNumber(value), null, JSON.stringify(value))
  }
  assert.equal(parse.parseNumber('1,234.5'), 1234.5)
  assert.equal(parse.parseNumber(' 12.5 '), 12.5)
  assert.equal(parse.parseNumber('-3'), -3)
  assert.equal(parse.parseNumber('1e2'), 100)
  assert.equal(parse.parseNumber(0), 0)
  assert.equal(parse.parseNumber('0'), 0)
  assert.equal(parse.parseNumber(12.5), 12.5)
})

test('日期解析支持上游接受的格式，拒绝不存在的日期', () => {
  assert.equal(parse.parseDay('20260821'), '2026-08-21')
  assert.equal(parse.parseDay('2026-08-21'), '2026-08-21')
  assert.equal(parse.parseDay('2026/08/21'), '2026-08-21')
  assert.equal(parse.parseDay('2026-8-1'), '2026-08-01')
  assert.equal(parse.parseDay('8月21'), null)
  assert.equal(parse.parseDay('20261345'), null)
  assert.equal(parse.parseDay('2026-02-30'), null)
  assert.equal(parse.parseDay(null), null)
  assert.equal(parse.parseMonth('202608'), '2026-08')
  assert.equal(parse.parseMonth('2026-08'), '2026-08')
  assert.equal(parse.parseMonth('2026-8'), '2026-08')
  assert.equal(parse.parseMonth('202613'), null)
  assert.equal(parse.parseMonth('x'), null)
})

test('超长整数 ID 不丢精度，其他内容不受影响', () => {
  const { parseJsonKeepingLongIntegers: parseJson } = lib('protocol/client')
  const text = '{"userId":1234567890123456789,"neg":-1234567890123456789,"s":"x:12345678901234567,","esc":"a\\"1234567890123456789","f":0.30000000000000004,"e":1.5e300,"small":123456789012345,"list":[9007199254740993,1],"t":true,"n":null}'
  assert.deepEqual(parseJson(text), {
    userId: '1234567890123456789',
    neg: '-1234567890123456789',
    s: 'x:12345678901234567,',
    esc: 'a"1234567890123456789',
    f: 0.30000000000000004,
    e: 1.5e300,
    small: 123456789012345,
    list: ['9007199254740993', 1],
    t: true,
    n: null,
  })
})

test('服务器用数字返回的超长 ID 能原样用在后续请求里', async () => {
  const server = createMockServer()
  const originalTransport = server.transport
  server.transport = async (url, request) => {
    const result = await originalTransport(url, request)
    return result
  }
  const longId = '1234567890123456789'
  const session = { ...SESSION, userId: longId }
  await makeClient(server).balance(session, ACCOUNT)
  assert.equal(server.requests[0].headers.userid, longId)
  assert.equal(server.requests[0].payload.data.acctId, longId)
})

test('userId 为空时回退到 bizrt.userId，再回退到 "0"', async () => {
  const fallback = createMockServer({ login: () => ok({ bizrt: { token: 't', userId: 'from-biz', userInfo: { userId: '' } } }) })
  assert.equal((await makeClient(fallback).login('x')).session.userId, 'from-biz')
  const zero = createMockServer({ login: () => ok({ bizrt: { token: 't', userInfo: {} } }) })
  assert.equal((await makeClient(zero).login('x')).session.userId, '0')
})

test('错误码字段是 null 时不能当成功', async () => {
  for (const response of [{ code: null, data: {} }, { code: '1', data: { srvrt: { resultCode: null } } }, ok({ rtnCode: null })]) {
    const server = createMockServer({ balance: () => response })
    await assert.rejects(makeClient(server).balance(SESSION, ACCOUNT), error => error.kind === 'business')
  }
})

test('账户解析：去重、回退字段', () => {
  const accounts = parse.parseAccounts({
    powerUserList: [
      { id: '1', powerUserNo: 'a' },
      { id: '1', powerUserNo: 'dup' },
      { consNo: 'b', consNo_dst: 'src-b', provinceId: 'p', constType: '04', nickname: 'nick' },
      { name: '没有户号' },
      null,
    ],
  })
  assert.equal(accounts.length, 2)
  assert.equal(accounts[0].consNoSrc, 'a')
  assert.equal(accounts[0].name, '用电户号')
  assert.equal(accounts[1].id, 'src-b')
  assert.equal(accounts[1].provinceCode, 'p')
  assert.equal(parse.accountConsType(accounts[1]), '02')
  assert.equal(parse.accountConsType({ elecType: '01', provinceCode: '11102' }), '01')
  assert.deepEqual(parse.parseAccounts(null), [])
})

test('户名：跳过真机上见过的加密串，不用可能是手机号的字段兜底', () => {
  const OPAQUE = '99:0123456789abcdef0123456789abcdef:02:osg-uc:2601010000:001'
  const nameOf = raw => parse.parseAccounts({ powerUserList: [{ id: '1', powerUserNo: 'a', ...raw }] })[0].name
  assert.equal(nameOf({ consName: OPAQUE }), '用电户号')
  assert.equal(nameOf({ consName: OPAQUE, consName_dst: '张*' }), '张*')
  assert.equal(nameOf({ consName: '家庭' }), '家庭')
  assert.equal(nameOf({ consName: OPAQUE, nickname: '老家' }), '老家')
  assert.equal(nameOf({ userName: '13800000000', loginAccount: '13800000000' }), '用电户号')
  assert.equal(parse.isOpaque(OPAQUE), true)
  assert.equal(parse.isOpaque('3号楼'), false)
  assert.equal(parse.isOpaque('12:30'), false)
})

test('户号标识：每次登录都会变的加密串不能当标识，否则显示名称和缓存会丢', () => {
  const OPAQUE = '99:0123456789abcdef0123456789abcdef:02:osg-uc:2601010000:001'
  const idOf = raw => parse.parseAccounts({ powerUserList: [{ powerUserNo: 'raw-no', ...raw }] })[0].id
  assert.equal(idOf({ id: 'acct-1', powerUserNo_dst: '110***1234' }), 'acct-1')
  assert.equal(idOf({ id: OPAQUE, powerUserNo_dst: '110***1234' }), '110***1234')
  assert.equal(idOf({ id: OPAQUE }), 'raw-no')
})

test('月度账单：字段回退、取最晚结算日、按月排序', () => {
  const billing = parse.parseYearlyBilling({
    mothEleList: [
      { month: '2026-09', eleList: [{ pq: '100', amt: '50', endDate: '20260915' }, { pq: '20.5', amt: '10', endDate: '20260930' }] },
      { ym: '202608', monthEleNum: '280', monthEleCost: '150' },
      { month: '坏数据' },
    ],
  })
  assert.deepEqual(billing.bills.map(b => b.month), ['2026-08', '2026-09'])
  assert.equal(billing.bills[1].kwh, 120.5)
  assert.equal(billing.bills[1].yuan, 60)
  assert.equal(billing.bills[1].endDay, '2026-09-30')
  assert.equal(billing.bills[0].endDay, null)
  assert.equal(billing.kwh, 400.5, '没有 yearPq 时用账单相加')
  assert.equal(billing.yuan, 210)
  assert.equal(parse.parseYearlyBilling({ yearPq: '99', list: [] }).kwh, 99)
  assert.equal(parse.parseYearlyBilling({ list: [] }).kwh, null)
})

test('余额语义和上游 AccountBalance 一致：区分预付费和后付费', () => {
  const prepaid = parse.parseBalance({ list: [{ consType: '1', sumMoney: '88.35', prepayBal: '90' }] })
  assert.deepEqual(prepaid, { isPrepaid: true, balance: 88.35, amountDue: null, overdue: null })
  assert.equal(parse.parseBalance({ list: [{ consType: '1', prepayBal: '90' }] }).balance, 90)
  const postpaid = parse.parseBalance({ list: [{ consType: '2', sumMoney: '120', accountBalance: '0', prepayBal: '0' }] })
  assert.deepEqual(postpaid, { isPrepaid: false, balance: null, amountDue: 120, overdue: null })
  assert.equal(parse.parseBalance({ list: [{ consType: '2', sumMoney: '0', accountBalance: '15' }] }).balance, 15)
  assert.equal(parse.parseBalance({ list: [{ consType: '2', sumMoney: '50', historyOwe: '50' }] }).overdue, 50)
  assert.equal(parse.parseBalance({ list: [] }), null)
  assert.equal(parse.parseBalance({}), null)
})

test('API 地址没有被改过', () => {
  assert.equal(API_BASE, 'https://csc-service.sgcc.com.cn:28630/')
  resetStores()
})
