'use strict'
// 业务策略：重点验证“什么情况下绝对不能联网”。每个场景都统计实际发出的请求数。
const test = require('node:test')
const assert = require('node:assert/strict')
const { lib, keychain, resetStores } = require('./support/shim.cjs')
const { createMockServer, TEST_KEYS, ok, fail } = require('./support/mock-server.cjs')

const { createService, normalizeParameter, pickAccount } = lib('service')
const { SgccError } = lib('protocol/client')
const { md5Hex } = lib('protocol/bytes')
const { saveSettings, loadSettings, vault } = lib('vault')

const HOUR = 3600 * 1000
const MINUTE = 60 * 1000
const START = Date.UTC(2026, 10, 4, 2, 0, 0)
const PASSWORD = 'correct-horse-密码'

function setup(overrides = {}) {
  resetStores()
  const server = createMockServer(overrides)
  const clock = { t: START }
  const service = createService(server.transport, { now: () => clock.t, keys: TEST_KEYS })
  return { server, clock, service }
}

async function signedIn(overrides = {}) {
  const context = setup(overrides)
  await context.service.signIn('13800000000', PASSWORD)
  context.server.requests.length = 0
  return context
}

const everything = () => [...keychain.entries()].map(([k, v]) => `${k}=${v}`).join('\n')

test('登录成功后不保存明文密码，只有 MD5', async () => {
  const { service } = setup()
  const state = await service.signIn('13800000000', PASSWORD)
  assert.equal(state.signedIn, true)
  assert.equal(state.accounts.length, 2)
  assert.ok(!everything().includes(PASSWORD), '钥匙串里不能有明文密码')
  assert.ok(everything().includes(md5Hex(PASSWORD)))
})

test('登录请求里也只有 MD5', async () => {
  const { service, server } = setup()
  await service.signIn('13800000000', PASSWORD)
  const body = JSON.stringify(server.requests[0].payload)
  assert.ok(!body.includes(PASSWORD))
  assert.equal(server.requests[0].payload.quInfo.password, md5Hex(PASSWORD))
})

test('密码错误时什么都不保存，小组件不会拿它去重试', async () => {
  const { service, server, clock } = setup({ login: () => fail('1001', '账号或密码错误') })
  await assert.rejects(service.signIn('13800000000', 'wrong'), error => error.kind === 'credentials' && error.message === '账号或密码错误')
  assert.equal(vault.credentials(), null)
  assert.equal(service.state().signedIn, false)
  server.requests.length = 0
  for (let i = 0; i < 5; i++) {
    clock.t += 30 * MINUTE
    assert.equal((await service.loadWidgetModel('')).state, 'signedOut')
  }
  assert.equal(server.requests.length, 0, '没有账号时小组件一次都不能联网')
})

test('新设备验证：4006 → 手动发短信 → 带验证码登录', async () => {
  let required = true
  const { service, server } = setup({
    login: payload => {
      if (required && !payload.quInfo.code) return fail('4006', '新设备')
      required = false
      return createMockServer().handlers.login()
    },
  })
  await assert.rejects(service.signIn('13800000000', PASSWORD), error => error.kind === 'device')
  assert.equal(server.count('sms'), 0, '不能自动发短信')
  assert.equal(vault.credentials(), null, '验证完成前不保存')
  const codeKey = await service.requestVerificationCode('13800000000')
  assert.equal(server.count('sms'), 1)
  const state = await service.signIn('13800000000', PASSWORD, { code: '123456', codeKey })
  assert.equal(state.signedIn, true)
  const last = server.requests[server.requests.length - 1].payload
  assert.equal(last.quInfo.code, '123456')
  assert.equal(last.quInfo.codeKey, 'code-key-1')
  assert.ok(!everything().includes('code-key-1'), 'codeKey 不落地')
})

test('设备身份在多次登录之间保持不变', async () => {
  const { service, server } = setup()
  await service.signIn('13800000000', PASSWORD)
  await service.signIn('13800000000', 'new-password')
  const guids = new Set(server.requests.map(r => r.headers.AppGuid))
  assert.equal(guids.size, 1, '改密码后设备不变，不会触发新设备验证')
})

/** 走完验证码登录：先发码，再带 codeKey 登录。 */
async function signInByCode(service, phone = '13800000000') {
  const codeKey = await service.requestLoginCode(phone)
  return service.signInWithCode(phone, '123456', codeKey)
}

test('验证码登录：发 login 类型的短信，不走密码接口，不保存密码和 codeKey', async () => {
  const { service, server } = setup()
  const state = await signInByCode(service)
  assert.equal(state.signedIn, true)
  assert.equal(state.canAutoLogin, false)
  assert.equal(state.accounts.length, 2)
  assert.ok(state.sessionExpiresAt > START)
  assert.deepEqual(vault.credentials(), { phone: '13800000000', passwordMd5: null })
  assert.equal(server.requests[0].payload.quInfo.businessType, 'login')
  assert.equal(server.count('sms'), 1)
  assert.equal(server.count('smsLogin'), 1)
  assert.equal(server.count('login'), 0)
  assert.ok(!everything().includes('code-key-1'), 'codeKey 不落地')
})

test('验证码登录后小组件用这次的登录正常查询', async () => {
  const { service, server } = setup()
  await signInByCode(service)
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'ok')
  assert.equal(model.view.notice, null)
  assert.equal(server.count('login'), 0)
  assert.equal(server.count('sms'), 1, '只有用户点的那一次')
})

test('验证码登录：格式不对、没有手机号或 codeKey 时不联网', async () => {
  const { service, server } = setup()
  await assert.rejects(service.signInWithCode('13800000000', '12345', 'k'), error => error.code === 'bad-code')
  await assert.rejects(service.signInWithCode('13800000000', '12345a', 'k'), error => error.code === 'bad-code')
  await assert.rejects(service.signInWithCode('13800000000', '123456', ''), error => error.code === 'no-code-key')
  await assert.rejects(service.signInWithCode('', '123456', 'k'), error => error.code === 'empty')
  assert.equal(server.requests.length, 0)
})

test('验证码错误时什么都不保存，小组件不会联网', async () => {
  const { service, server } = setup({ smsLogin: () => fail('1001', '验证码错误') })
  await assert.rejects(service.signInWithCode('13800000000', '000000', 'k'), error => error.kind === 'credentials' && error.message === '验证码错误')
  assert.equal(vault.credentials(), null)
  assert.equal(vault.session(), null)
  server.requests.length = 0
  assert.equal((await service.loadWidgetModel('')).state, 'signedOut')
  assert.equal(server.requests.length, 0)
})

test('只用验证码登录过：到期后小组件不联网、不发短信，一直提示重新登录', async () => {
  const { service, server, clock } = setup()
  await signInByCode(service)
  await service.loadWidgetModel('')
  server.requests.length = 0
  clock.t += 16 * 24 * HOUR
  for (let i = 0; i < 10; i++) {
    const model = await service.loadWidgetModel('')
    assert.equal(model.state, 'ok', '已有的数据继续显示')
    assert.equal(model.view.notice, '登录已过期，需要重新登录')
    clock.t += 6 * HOUR
  }
  assert.equal(server.requests.length, 0)
  assert.equal(service.state().block, null, '不算账号被拒，闸门不关')
  assert.equal(service.state().sessionExpiresAt, null)
})

test('只用验证码登录过且没有数据时，到期后也有明确提示', async () => {
  const { service, server, clock } = setup()
  await signInByCode(service)
  server.requests.length = 0
  clock.t += 16 * 24 * HOUR
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'error')
  assert.equal(model.message, '登录已过期，需要重新登录')
  assert.equal(server.requests.length, 0)
})

test('只用验证码登录过：到期后连续刷新也不会说“稍后自动重试”，等用户登录前不需要频繁刷新', async () => {
  const { service, clock } = setup()
  await signInByCode(service)
  clock.t += 16 * 24 * HOUR
  for (let i = 0; i < 3; i++) {
    const model = await service.loadWidgetModel('')
    assert.equal(model.message, '登录已过期，需要重新登录')
    assert.equal(model.nextRefresh.getTime(), clock.t + loadSettings().refreshHours * HOUR)
    clock.t += MINUTE
  }
})

test('只用验证码登录过：会话被提前作废时清掉会话，不再联网', async () => {
  const { service, server, clock } = setup({ daily: () => fail('-200') })
  await signInByCode(service)
  server.requests.length = 0
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'error')
  assert.equal(model.message, '登录已过期，需要重新登录')
  assert.equal(server.count('daily'), 1, '只查了发现作废的那一次')
  assert.equal(server.count('login') + server.count('smsLogin') + server.count('sms'), 0)
  assert.equal(service.state().sessionExpiresAt, null)
  server.requests.length = 0
  clock.t += 2 * HOUR
  await service.loadWidgetModel('')
  assert.equal(server.requests.length, 0)
})

test('只用验证码登录过：手动刷新和诊断在到期后也不联网', async () => {
  const { service, server, clock } = setup()
  await signInByCode(service)
  server.requests.length = 0
  clock.t += 16 * 24 * HOUR
  const expired = error => error.kind === 'session' && error.code === 'no-password'
  await assert.rejects(service.refreshNow(), expired)
  await assert.rejects(service.diagnoseDaily(), expired)
  assert.equal(server.requests.length, 0)
  assert.equal(service.state().block, null)
})

test('到期后再用验证码登录一次就恢复', async () => {
  const { service, clock } = setup()
  await signInByCode(service)
  await service.loadWidgetModel('')
  clock.t += 16 * 24 * HOUR
  assert.equal((await service.loadWidgetModel('')).view.notice, '登录已过期，需要重新登录')
  await signInByCode(service)
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'ok')
  assert.equal(model.view.notice, null)
  assert.equal(vault.snapshot('acct-1').fetchedAt, clock.t, '同一个账号的数据保留，并刷新到最新')
})

test('用密码登录过的号改用验证码登录：密码 MD5 留着，到期还能自动续', async () => {
  const { service, server, clock } = await signedIn()
  const state = await signInByCode(service)
  assert.equal(state.canAutoLogin, true)
  assert.equal(vault.credentials().passwordMd5, md5Hex(PASSWORD))
  server.requests.length = 0
  clock.t += 16 * 24 * HOUR
  assert.equal((await service.loadWidgetModel('')).state, 'ok')
  assert.equal(server.count('login'), 1)
  assert.equal(server.count('sms') + server.count('smsLogin'), 0)
})

test('换手机号用验证码登录：不带上旧号的密码，旧号的数据清掉', async () => {
  const { service } = await signedIn()
  await service.loadWidgetModel('')
  assert.ok(vault.snapshot('acct-1'))
  const state = await signInByCode(service, '13900000000')
  assert.deepEqual(vault.credentials(), { phone: '13900000000', passwordMd5: null })
  assert.equal(state.canAutoLogin, false)
  assert.equal(vault.snapshot('acct-1'), null)
})

test('密码被国网拒绝后改用验证码登录：闸门打开，被拒的密码不留着', async () => {
  const defaults = createMockServer().handlers
  let rejected = false
  const { service, server, clock } = await signedIn({ login: () => (rejected ? fail('1001', '密码错误') : defaults.login()) })
  rejected = true
  clock.t += 16 * 24 * HOUR
  await service.loadWidgetModel('')
  assert.equal(service.state().block.kind, 'credentials')
  const state = await signInByCode(service)
  assert.equal(state.block, null)
  assert.equal(state.canAutoLogin, false)
  assert.equal(vault.credentials().passwordMd5, null)
  server.requests.length = 0
  clock.t += 16 * 24 * HOUR
  await service.loadWidgetModel('')
  assert.equal(server.count('login'), 0, '到期后不能再拿被拒的密码去试')
})

test('风控闸门关着时验证码登录成功：闸门打开，小组件恢复，密码留着', async () => {
  const defaults = createMockServer().handlers
  let blocked = true
  const { service } = await signedIn({ daily: payload => (blocked ? fail('RK008') : defaults.daily(payload)) })
  await service.loadWidgetModel('')
  assert.equal(service.state().block.kind, 'risk')
  blocked = false
  const state = await signInByCode(service)
  assert.equal(state.block, null)
  assert.equal(state.canAutoLogin, true)
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'ok')
  assert.equal(model.view.notice, null)
})

test('验证码登录被风控拦下：现有登录、设备身份和闸门都不变', async () => {
  const { service, server } = await signedIn({ smsLogin: () => fail('RK008', '网络连接超时 (RK008),请重试!') })
  const session = vault.session()
  const seed = vault.device('13800000000').seedHex
  await assert.rejects(signInByCode(service), error => error.kind === 'risk' && error.code === 'RK008')
  assert.deepEqual(vault.session(), session)
  assert.equal(vault.device('13800000000').seedHex, seed)
  assert.equal(vault.credentials().passwordMd5, md5Hex(PASSWORD))
  assert.equal(service.state().block, null, '现有登录还能用，不用停掉小组件')
  assert.equal(server.count('smsLogin'), 1)
})

test('全新安装时发码或验证码登录被风控拦下：不保存账号，再试还是同一个设备身份', async () => {
  const blockedSend = setup({ sms: () => fail('RK008') })
  await assert.rejects(blockedSend.service.requestLoginCode('13800000000'), error => error.kind === 'risk')
  assert.equal(vault.credentials(), null)

  const { service, server } = setup({ smsLogin: () => fail('RK008') })
  for (let i = 0; i < 2; i++) await assert.rejects(signInByCode(service), error => error.kind === 'risk')
  assert.equal(vault.credentials(), null)
  assert.equal(service.state().signedIn, false)
  assert.equal(new Set(server.requests.map(r => r.headers.AppGuid)).size, 1)
})

test('密码登录和验证码登录用同一个设备身份，切换不会变成新设备', async () => {
  const { service, server } = setup()
  await service.signIn('13800000000', PASSWORD)
  await signInByCode(service)
  await service.signIn('13800000000', PASSWORD)
  assert.equal(new Set(server.requests.map(r => r.headers.AppGuid)).size, 1)
})

test('小组件：缓存有效时不联网', async () => {
  const { service, server, clock } = await signedIn()
  assert.equal((await service.loadWidgetModel('')).state, 'ok')
  const firstRun = server.requests.length
  assert.ok(firstRun > 0)
  clock.t += 11 * HOUR
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'ok')
  assert.equal(server.requests.length, firstRun, '12 小时内不应该再联网')
})

test('小组件：一次刷新的请求数有上限，并且数据正确', async () => {
  const { service, server } = await signedIn()
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'ok')
  assert.equal(server.count('login'), 0, '会话有效时不重新登录')
  assert.ok(server.requests.length <= 5, `实际 ${server.requests.length} 次`)
  assert.equal(model.nextRefresh.getTime(), START + 12 * HOUR)
  const snapshot = vault.snapshot('acct-1')
  assert.equal(snapshot.monthKwh, 30.5)
  assert.equal(snapshot.balance.balance, 88.35)
  assert.equal(snapshot.lastBill.month, '2026-09')
  assert.equal(snapshot.yearKwh, 2000)
  // 结算到 9/30，之后的每日：10/30 12 + 10/31 8 + 11/1 20 + 11/2 10.5
  assert.equal(snapshot.yearEstimateKwh, 2050.5)
  assert.deepEqual(snapshot.daily.map(d => d.day), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'])
  assert.equal(snapshot.daily[4].kwh, null, '占位符保持 null')
})

test('默认设置：按北京标准算出档位和本月电费', async () => {
  const { service } = await signedIn()
  const { view } = await service.loadWidgetModel('')
  assert.equal(view.tier.level, 1)
  assert.equal(view.tier.text, '第一档 0.4883 元/度 · 距第二档 830 度')
  assert.equal(view.monthCost, '14.89', '30.5 度 × 0.4883')
})

test('旧版本存下的设置：没填的阶梯和单价用北京默认，填过的保留', () => {
  resetStores()
  saveSettings({ accountId: 'a', names: { a: '家' }, tier2: 3000, tier3: 0, chartDays: 7, refreshHours: 6 })
  const settings = loadSettings()
  assert.deepEqual([settings.tier2, settings.tier3], [3000, 4800])
  assert.deepEqual([settings.price1, settings.price2, settings.price3], [0.4883, 0.5383, 0.7883])
  assert.deepEqual([settings.accountId, settings.names.a, settings.chartDays, settings.refreshHours], ['a', '家', 7, 6])
})

/** 已结算到上月底，不需要为了阶梯估算去查上个月。 */
const settledThroughOctober = () => ok({ yearPq: '100', list: [{ month: '202610', monthPq: '100', eleList: [{ endDate: '20261031' }] }] })

/** 本月 3 天，上个整月只给 1 天，滚动窗口给满。真机上出现过读数特别少的情况，这是其中一种可能。 */
function sparseMonthDaily(payload) {
  const { startTime, endTime } = payload.data
  const day = n => ({ day: `202611${String(n).padStart(2, '0')}`, dayElePq: '10' })
  if (startTime === '2026-11-01') return ok({ totalPq: '30', sevenEleList: [day(1), day(2), day(3), { day: '20261104', dayElePq: '-' }] })
  if (startTime === '2026-10-01' && endTime === '2026-10-31') return ok({ sevenEleList: [{ day: '20261031', dayElePq: '9' }] })
  // 滚动窗口：10/1 到今天
  const october = Array.from({ length: 31 }, (_, i) => ({ day: `202610${String(i + 1).padStart(2, '0')}`, dayElePq: '9' }))
  return ok({ totalPq: '309', sevenEleList: [...october, day(1), day(2), day(3), { day: '20261104', dayElePq: '-' }] })
}

const dailyRanges = server => server.requests.filter(r => r.route === 'daily').map(r => `${r.payload.data.startTime}~${r.payload.data.endTime}`)

test('整月查询读数很少时，靠滚动窗口把柱状图补满', async () => {
  const { service, server } = await signedIn({ daily: sparseMonthDaily, monthly: settledThroughOctober })
  const model = await service.loadWidgetModel('')
  assert.equal(model.view.bars.length, 14)
  assert.equal(model.view.chartSlots, 14)
  assert.equal(model.view.latest.label, '11/3')
  assert.deepEqual(dailyRanges(server), ['2026-11-01~2026-11-30', '2026-10-01~2026-10-31', '2026-10-01~2026-11-04'], '整月够用就不发滚动窗口')
  assert.equal(vault.snapshot('acct-1').monthKwh, 30, '本月用电仍然取本月查询的合计')
})

test('读数攒够之后不再多查，接口少返回几天柱状图也不倒退', async () => {
  const { service, server, clock } = await signedIn({ daily: sparseMonthDaily, monthly: settledThroughOctober })
  await service.loadWidgetModel('')
  server.requests.length = 0
  server.handlers.daily = () => ok({ totalPq: '30', sevenEleList: [{ day: '20261104', dayElePq: '11' }] })
  clock.t += 13 * HOUR
  const model = await service.loadWidgetModel('')
  assert.equal(server.count('daily'), 1, '只查本月')
  assert.equal(model.view.bars.length, 14)
  assert.equal(model.view.latest.label, '11/4')
  assert.equal(vault.snapshot('acct-1').daily.length, 31, '存储有上限')
})

test('滚动窗口失败不影响整次更新，网络错误也一样', async () => {
  const rollingFails = failure => payload => {
    if (payload.data.startTime === '2026-11-01') return ok({ sevenEleList: [{ day: '20261101', dayElePq: '14' }] })
    if (payload.data.endTime === '2026-11-04') return failure()
    return ok({ sevenEleList: [{ day: '20261031', dayElePq: '13' }] })
  }
  const failures = [() => fail('9999', '不支持'), () => { throw new Error('offline') }]
  for (const failure of failures) {
    const { service, server } = await signedIn({ daily: rollingFails(failure) })
    const model = await service.loadWidgetModel('')
    assert.equal(model.state, 'ok')
    assert.equal(model.view.notice, null)
    assert.equal(model.view.bars.length, 2)
    assert.equal(server.count('daily'), 3)
    assert.ok(vault.snapshot('acct-1').balance, '后面的余额查询不能被耽误')
  }
})

test('上个月没出账时，柱状图够用也要查整月，否则阶梯估算会漏掉月初几天', async () => {
  const november = Array.from({ length: 16 }, (_, i) => ({ day: `202611${String(i + 1).padStart(2, '0')}`, dayElePq: '5' }))
  const { service, server } = await signedIn({
    daily: payload => (payload.data.startTime === '2026-11-01' ? ok({ totalPq: '80', sevenEleList: november }) : ok({ sevenEleList: [{ day: '20261001', dayElePq: '7' }] })),
    monthly: () => ok({ yearPq: '100', list: [{ month: '202609', monthPq: '100', eleList: [{ endDate: '20260930' }] }] }),
  })
  await service.loadWidgetModel('')
  assert.deepEqual(dailyRanges(server), ['2026-11-01~2026-11-30', '2026-10-01~2026-10-31'])
  assert.equal(vault.snapshot('acct-1').yearEstimateKwh, 187)
})

test('合并多次查询时，占位行不能盖掉真实读数', async () => {
  const { service } = await signedIn({
    daily: payload =>
      payload.data.startTime === '2026-11-01'
        ? ok({ sevenEleList: [{ day: '20261101', dayElePq: '14' }, { day: '20261102', dayElePq: '-' }] })
        : ok({ sevenEleList: [{ day: '20261101', dayElePq: '-' }, { day: '20261102', dayElePq: '9' }] }),
  })
  await service.loadWidgetModel('')
  const { daily } = vault.snapshot('acct-1')
  assert.deepEqual(daily.map(d => [d.day, d.kwh]), [['2026-11-01', 14], ['2026-11-02', 9]])
})

test('诊断：报告三次查询的条数和字段，不含账号和户号', async () => {
  const { service, server } = await signedIn({ daily: sparseMonthDaily })
  const report = await service.diagnoseDaily('acct-1')
  assert.equal(server.count('daily'), 3)
  assert.match(report, /【本月】2026-11-01 ~ 2026-11-30/)
  assert.match(report, /返回 4 行，有读数 3 行，totalPq=30/)
  assert.match(report, /【最近35天】2026-10-01 ~ 2026-11-04/)
  assert.match(report, /【上月】2026-10-01 ~ 2026-10-31/)
  assert.match(report, /返回 1 行，有读数 1 行/)
  assert.match(report, /20261031=9/)
  assert.match(report, /行字段：day, dayElePq/)
  for (const secret of ['13800000000', '1100001234', 'enc-1', 'token-1', md5Hex(PASSWORD)]) {
    assert.ok(!report.includes(secret), `诊断报告不能包含 ${secret}`)
  }
})

test('诊断：单次查询失败不影响其他', async () => {
  const defaults = createMockServer().handlers
  const { service } = await signedIn({
    daily: payload => (payload.data.endTime === '2026-11-30' ? fail('9999', '系统繁忙') : defaults.daily(payload)),
  })
  const report = await service.diagnoseDaily()
  assert.match(report, /失败：9999 系统繁忙/)
  assert.match(report, /【上月】/)
  assert.match(report, /【最近35天】/)
})

test('诊断：遇到风控立刻停下并关上闸门，闸门关着时不联网', async () => {
  const { service, server } = await signedIn({ daily: () => fail('RK008') })
  await assert.rejects(service.diagnoseDaily(), error => error.kind === 'risk')
  assert.equal(server.count('daily'), 1, '后面的查询不能再发')
  assert.equal(service.state().block.kind, 'risk', '小组件也要停')
  server.requests.length = 0
  await assert.rejects(service.diagnoseDaily(), error => error.kind === 'risk')
  assert.equal(server.requests.length, 0)
})

test('本月数据够用且已结算到上月时，不查上个月', async () => {
  const days = Array.from({ length: 16 }, (_, i) => ({ day: `202611${String(i + 1).padStart(2, '0')}`, dayElePq: '5' }))
  const { service, server } = await signedIn({
    daily: () => ok({ totalPq: '80', sevenEleList: days }),
    monthly: () => ok({ yearPq: '100', list: [{ month: '202610', monthPq: '100', eleList: [{ endDate: '20261031' }] }] }),
  })
  await service.loadWidgetModel('')
  assert.equal(server.count('daily'), 1)
  assert.equal(vault.snapshot('acct-1').yearEstimateKwh, 180)
})

test('一月份：今年还没有账单时用去年的账单显示上期，阶梯只算今年', async () => {
  const context = await signedIn({
    daily: payload => {
      if (payload.data.startTime.startsWith('2027-01')) return ok({ totalPq: '30', sevenEleList: [{ day: '20270102', dayElePq: '30' }] })
      return ok({ sevenEleList: [{ day: '20261231', dayElePq: '99' }] })
    },
    monthly: payload => (payload.data.year === 2027 ? ok({ list: [] }) : ok({ yearPq: '4000', list: [{ month: '202611', monthPq: '300', monthAmt: '150' }] })),
  })
  context.clock.t = Date.UTC(2027, 0, 5, 2, 0, 0)
  // 让会话不过期
  vault.saveSession({ ...vault.session(), expiresAt: context.clock.t + 1e9 })
  await context.service.loadWidgetModel('')
  const snapshot = vault.snapshot('acct-1')
  assert.equal(snapshot.lastBill.month, '2026-11')
  assert.equal(snapshot.yearEstimateKwh, 30, '不能把去年的用电算进今年阶梯')
})

test('余额接口失败：其他数据照常显示，余额留空不当 0', async () => {
  for (const balance of [() => fail('9999', '地区不支持'), () => { throw new Error('timeout') }, () => ok({ list: [] })]) {
    const { service } = await signedIn({ balance })
    const model = await service.loadWidgetModel('')
    assert.equal(model.state, 'ok')
    assert.equal(model.view.headline.amount, '--')
    assert.equal(model.view.monthKwh, '30.5')
  }
})

test('小组件有总时限：网关很慢时及时放弃，把旧数据画出来', async () => {
  const { service, server, clock } = await signedIn()
  await service.loadWidgetModel('')
  const good = vault.snapshot('acct-1')
  const before = server.requests.length
  // 每个请求耗时 15 秒，25 秒的预算只够发两个。
  const defaults = createMockServer().handlers
  const slow = handler => (...args) => {
    clock.t += 15 * 1000
    return handler(...args)
  }
  server.handlers.daily = slow(defaults.daily)
  server.handlers.monthly = slow(defaults.monthly)
  server.handlers.balance = slow(defaults.balance)
  clock.t += 13 * HOUR
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'ok')
  assert.ok(server.requests.length - before <= 2, `发了 ${server.requests.length - before} 个请求`)
  assert.deepEqual(vault.snapshot('acct-1').daily, good.daily)
})

test('小组件的单个请求超时不超过剩余预算；手动操作不受总时限限制', async () => {
  const seen = []
  const { server, clock } = await signedIn()
  const original = server.transport
  const service = createService(async (url, request) => {
    seen.push(request.timeoutSeconds)
    clock.t += 10 * 1000
    return original(url, request)
  }, { now: () => clock.t, keys: TEST_KEYS })
  await service.loadWidgetModel('')
  assert.deepEqual(seen.slice(0, 3), [20, 15, 5], '每次都只给剩余的预算')
  assert.equal(seen.length, 3, '预算用完就不再发请求')

  seen.length = 0
  await service.refreshNow('acct-2')
  assert.ok(seen.length >= 3, '手动刷新不受小组件的总时限影响')
  assert.ok(seen.every(seconds => seconds === 20))
})

test('临时错误不会用空数据冲掉好的缓存', async () => {
  const defaults = createMockServer().handlers
  const { service, server, clock } = await signedIn()
  await service.loadWidgetModel('')
  const good = vault.snapshot('acct-1')
  assert.equal(good.balance.balance, 88.35)

  // 每日接口临时报错：整次作废，保留旧数据，一小时后重试，不等 12 小时。
  server.handlers.daily = () => fail('9999', '系统繁忙')
  clock.t += 13 * HOUR
  const failed = await service.loadWidgetModel('')
  assert.equal(failed.state, 'ok')
  assert.equal(failed.view.notice, '更新失败，稍后重试')
  assert.equal(failed.nextRefresh.getTime(), clock.t + HOUR)
  assert.deepEqual(vault.snapshot('acct-1'), good, '缓存一个字都不能变')

  // 余额和账单接口报错：其他数据更新，失败的字段保留上次的值。
  server.handlers.daily = defaults.daily
  server.handlers.balance = () => fail('9999')
  server.handlers.monthly = () => fail('9999')
  clock.t += HOUR
  const partial = await service.loadWidgetModel('')
  assert.equal(partial.view.headline.amount, '88.35')
  const merged = vault.snapshot('acct-1')
  assert.equal(merged.fetchedAt, clock.t)
  assert.deepEqual(merged.balance, good.balance)
  assert.deepEqual(merged.lastBill, good.lastBill)
  assert.equal(merged.yearKwh, good.yearKwh)
  assert.equal(merged.yearEstimateKwh, good.yearEstimateKwh)
})

test('跨年后账单接口失败：不把去年的累计当成今年的', async () => {
  const { service, server, clock } = await signedIn()
  await service.loadWidgetModel('')
  assert.equal(vault.snapshot('acct-1').yearKwh, 2000)
  server.handlers.monthly = () => fail('9999')
  server.handlers.daily = () => ok({ totalPq: '5', sevenEleList: [{ day: '20270103', dayElePq: '5' }] })
  clock.t = Date.UTC(2027, 0, 5, 2, 0, 0)
  vault.saveSession({ ...vault.session(), expiresAt: clock.t + 1e9 })
  await service.loadWidgetModel('')
  const snapshot = vault.snapshot('acct-1')
  assert.equal(snapshot.fetchedAt, clock.t)
  assert.equal(snapshot.yearKwh, null)
  assert.equal(snapshot.yearEstimateKwh, null)
})

test('从来没查到过每日数据（地区不支持）：不影响余额显示', async () => {
  const { service, clock } = await signedIn({ daily: () => fail('9999', '地区不支持') })
  const first = await service.loadWidgetModel('')
  assert.equal(first.state, 'ok')
  assert.equal(first.view.headline.amount, '88.35')
  assert.deepEqual(first.view.bars, [])
  clock.t += 13 * HOUR
  const second = await service.loadWidgetModel('')
  assert.equal(second.state, 'ok')
  assert.equal(second.view.notice, null, '持续不支持不算错误')
  assert.equal(vault.snapshot('acct-1').fetchedAt, clock.t)
})

test('验证码格式不对时不发给国网', async () => {
  const { service, server } = setup()
  for (const code of ['12345', '1234567', 'abcdef', '']) {
    await assert.rejects(service.signIn('13800000000', PASSWORD, { code, codeKey: 'k' }), /6 位数字/)
  }
  assert.equal(server.requests.length, 0)
})

test('月度账单接口失败：不影响每日数据，阶梯不显示', async () => {
  const { service } = await signedIn({ monthly: () => fail('9999') })
  saveSettings({ ...loadSettings(), tier2: 2880, tier3: 4800 })
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'ok')
  assert.equal(model.view.tier, null)
  assert.equal(model.view.monthCost, null)
  assert.equal(model.view.lastBill, null)
  assert.equal(model.view.monthKwh, '30.5')
})

test('所有接口都报错：没有缓存时显示错误，且不联网重试', async () => {
  const { service, server, clock } = await signedIn({ daily: () => fail('9999'), monthly: () => fail('9999'), balance: () => fail('9999') })
  const first = await service.loadWidgetModel('')
  assert.equal(first.state, 'error')
  assert.equal(first.nextRefresh.getTime(), START + HOUR)
  const count = server.requests.length
  clock.t += 10 * MINUTE
  assert.equal((await service.loadWidgetModel('')).state, 'error')
  assert.equal(server.requests.length, count, '30 分钟内不重试')
})

test('网络断开：保留旧数据，不算账号问题，之后能自动恢复', async () => {
  let online = true
  const guard = response => (...args) => {
    if (!online) throw new Error('offline')
    return response(...args)
  }
  const defaults = createMockServer().handlers
  const { service, server, clock } = await signedIn({ daily: guard(defaults.daily), monthly: guard(defaults.monthly), balance: guard(defaults.balance) })
  await service.loadWidgetModel('')
  online = false
  clock.t += 13 * HOUR
  const offline = await service.loadWidgetModel('')
  assert.equal(offline.state, 'ok')
  assert.equal(offline.view.notice, '更新失败，稍后重试')
  assert.equal(offline.nextRefresh.getTime(), clock.t + HOUR)
  assert.equal(service.state().block, null, '断网不能被当成账号问题')
  const count = server.requests.length
  clock.t += 10 * MINUTE
  await service.loadWidgetModel('')
  assert.equal(server.requests.length, count, '30 分钟内不重试')
  online = true
  clock.t += 30 * MINUTE
  const recovered = await service.loadWidgetModel('')
  assert.equal(recovered.view.notice, null)
  assert.equal(vault.snapshot('acct-1').fetchedAt, clock.t)
})

test('改过密码（自动登录被拒）：只试一次，之后小组件完全不再联网', async () => {
  let rejected = false
  const defaults = createMockServer().handlers
  const { service, server, clock } = await signedIn({ login: () => (rejected ? fail('1001', '密码错误') : defaults.login()) })
  await service.loadWidgetModel('')
  rejected = true
  // 会话到期（约 15 天后）
  clock.t += 16 * 24 * HOUR
  const first = await service.loadWidgetModel('')
  assert.equal(server.count('login'), 1)
  assert.equal(first.state, 'ok', '还能看到旧数据')
  assert.match(first.view.notice, /重新登录/)
  assert.equal(service.state().block.kind, 'credentials')

  server.requests.length = 0
  for (let i = 0; i < 20; i++) {
    clock.t += HOUR
    const model = await service.loadWidgetModel('')
    assert.match(model.view.notice, /重新登录/)
  }
  assert.equal(server.requests.length, 0, '被拒绝后一次都不能再联网（这是原项目最大的问题）')

  await assert.rejects(service.refreshNow(), error => error.kind === 'credentials', '手动刷新也要先重新登录')
  assert.equal(server.requests.length, 0)

  rejected = false
  const state = await service.signIn('13800000000', 'new-password')
  assert.equal(state.block, null)
  assert.equal((await service.loadWidgetModel('')).view.notice, null)
  assert.ok(vault.credentials().passwordMd5 === md5Hex('new-password'))
})

test('手动重新登录被 RK007 拦下：现有登录和设备身份不变，小组件照常工作', async () => {
  const defaults = createMockServer().handlers
  let blocked = false
  const { service, server } = await signedIn({
    login: () => (blocked ? fail('RK007', '网络连接超时 (RK007),请重试!') : defaults.login()),
  })
  const session = vault.session()
  const seed = vault.device('13800000000').seedHex
  blocked = true
  await assert.rejects(service.signIn('13800000000', PASSWORD), error => error.kind === 'risk' && error.code === 'RK007')
  assert.deepEqual(vault.session(), session)
  assert.equal(vault.device('13800000000').seedHex, seed)
  assert.equal(service.state().block, null, '现有登录还能用，不用停掉小组件')
  assert.equal(service.state().sessionExpiresAt, session.expiresAt)
  server.requests.length = 0
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'ok')
  assert.equal(model.view.notice, null)
  assert.equal(server.count('login'), 0)
})

test('全新安装时登录被 RK007 拦下：不保存账号，再试还是同一个设备身份', async () => {
  const { service, server } = setup({ login: () => fail('RK007', '网络连接超时 (RK007),请重试!') })
  for (let i = 0; i < 2; i++) {
    await assert.rejects(service.signIn('13800000000', PASSWORD), error => error.kind === 'risk')
  }
  assert.equal(vault.credentials(), null)
  assert.equal(service.state().signedIn, false)
  assert.equal(new Set(server.requests.map(r => r.headers.AppGuid)).size, 1)
  assert.equal(server.count('sms'), 0, '风控不能靠自动发短信解决')
})

test('风控（RK008、RK007）和新设备（4006）同样立即停止，且绝不自动发短信', async () => {
  for (const [code, kind] of [['RK008', 'risk'], ['RK007', 'risk'], ['4006', 'device']]) {
    const defaults = createMockServer().handlers
    let triggered = false
    const { service, server, clock } = await signedIn({ login: () => (triggered ? fail(code) : defaults.login()) })
    await service.loadWidgetModel('')
    triggered = true
    clock.t += 16 * 24 * HOUR
    await service.loadWidgetModel('')
    assert.equal(service.state().block.kind, kind)
    server.requests.length = 0
    for (let i = 0; i < 10; i++) {
      clock.t += 6 * HOUR
      await service.loadWidgetModel('')
    }
    assert.equal(server.requests.length, 0)
    assert.equal(server.count('sms'), 0)
  }
})

test('查询时遇到风控也立即停止', async () => {
  const { service, server, clock } = await signedIn({ daily: () => fail('RK008') })
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'error')
  assert.equal(service.state().block.kind, 'risk')
  server.requests.length = 0
  clock.t += 2 * HOUR
  await service.loadWidgetModel('')
  assert.equal(server.requests.length, 0)
})

test('会话被服务端提前作废：重新登录一次并重试', async () => {
  let logins = 0
  const defaults = createMockServer().handlers
  const { service, server } = await signedIn({
    login: () => {
      logins++
      const response = defaults.login()
      response.data.bizrt.token = `token-${logins}`
      return response
    },
    daily: (payload, headers) => (headers.t === 'token-2' ? defaults.daily(payload) : fail('-200')),
  })
  assert.equal(vault.session().token, 'token-1')
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'ok')
  assert.equal(server.count('login'), 1, '重新登录恰好一次')
  assert.equal(vault.session().token, 'token-2')
  assert.equal(service.state().block, null)
})

test('重新登录后仍然 -200：不会死循环，只试一次', async () => {
  const { service, server } = await signedIn({ daily: () => fail('-200') })
  const model = await service.loadWidgetModel('')
  assert.equal(model.state, 'error')
  assert.equal(server.count('login'), 1)
  assert.equal(server.count('daily'), 2)
})

test('自动登录 12 小时内最多一次，即使网络一直失败', async () => {
  const { service, server, clock } = await signedIn()
  server.handlers.login = () => {
    throw new Error('offline')
  }
  vault.clearSession()
  clock.t += 13 * HOUR
  for (let i = 0; i < 24; i++) {
    await service.loadWidgetModel('')
    clock.t += HOUR / 2
  }
  // 12 小时一次，12 小时内只能有 1 次
  assert.equal(server.count('login'), 1, `实际 ${server.count('login')} 次`)
  assert.equal(service.state().block, null, '网络问题不算账号问题')
  clock.t += 12 * HOUR
  await service.loadWidgetModel('')
  assert.equal(server.count('login'), 2)
})

test('自动登录的尝试在联网前就记录，进程被杀也算数', async () => {
  const { service, server, clock } = await signedIn()
  let checked = false
  server.handlers.login = () => {
    assert.equal(vault.gate().lastAutoLoginAt, clock.t, '必须先记录再请求')
    checked = true
    return createMockServer().handlers.login()
  }
  vault.clearSession()
  clock.t += 13 * HOUR
  assert.equal((await service.loadWidgetModel('')).state, 'ok')
  assert.ok(checked)
})

test('手动刷新不受后台频率限制', async () => {
  const { service, server } = await signedIn()
  await service.loadWidgetModel('')
  const before = server.requests.length
  await service.refreshNow('acct-2')
  assert.ok(server.requests.length > before)
  assert.ok(vault.snapshot('acct-2'))
})

test('手动刷新被拒时记录闸门', async () => {
  const { service } = await signedIn({ daily: () => fail('RK008') })
  await assert.rejects(service.refreshNow(), error => error instanceof SgccError && error.kind === 'risk')
  assert.equal(service.state().block.kind, 'risk')
})

test('换账号时清掉旧账号的用电数据', async () => {
  const { service } = await signedIn()
  await service.refreshNow('acct-1')
  assert.ok(vault.snapshot('acct-1'))
  await service.signIn('13900000000', PASSWORD)
  assert.equal(vault.snapshot('acct-1'), null)
})

test('清除数据后什么都不剩', async () => {
  const { service } = await signedIn()
  await service.refreshNow('acct-1')
  saveSettings({ ...loadSettings(), tier2: 1 })
  service.eraseAll()
  assert.equal(keychain.size, 0)
  assert.equal(loadSettings().tier2, 2880, '设置也回到默认值')
  assert.equal(service.state().signedIn, false)
})

test('钥匙串清除失败时要报错，不能假装清除成功', async () => {
  const { service } = await signedIn()
  const original = Keychain.clear
  Keychain.clear = () => false
  try {
    assert.throws(() => service.eraseAll(), /清除失败/)
    assert.equal(service.state().signedIn, true)
  } finally {
    Keychain.clear = original
  }
})

test('小组件参数：预览传 JSON，桌面传普通文本', () => {
  assert.equal(normalizeParameter('"demo"'), 'demo')
  assert.equal(normalizeParameter('""'), '')
  assert.equal(normalizeParameter(' 2 '), '2')
  assert.equal(normalizeParameter('"坏 JSON'), '"坏 JSON')
  assert.equal(normalizeParameter(undefined), '')
  assert.equal(normalizeParameter(null), '')
})

test('选户号：指定了却找不到时不偷偷显示别的户', () => {
  const accounts = [
    { id: 'a', name: '张*', consNoSrc: '1100001234' },
    { id: 'b', name: '李*', consNoSrc: '1100005678' },
  ]
  const settings = { accountId: 'b', names: { a: '老家' } }
  assert.equal(pickAccount(accounts, settings, '').id, 'b')
  assert.equal(pickAccount(accounts, { accountId: null, names: {} }, '').id, 'a')
  assert.equal(pickAccount(accounts, settings, '1').id, 'a')
  assert.equal(pickAccount(accounts, settings, '2').id, 'b')
  assert.equal(pickAccount(accounts, settings, '3'), null)
  assert.equal(pickAccount(accounts, settings, '老家').id, 'a')
  assert.equal(pickAccount(accounts, settings, '李*').id, 'b')
  assert.equal(pickAccount(accounts, settings, '5678').id, 'b')
  assert.equal(pickAccount(accounts, settings, '不存在'), null)
})

test('小组件参数指向不存在的户号时显示提示，不联网', async () => {
  const { service, server } = await signedIn()
  const model = await service.loadWidgetModel('99')
  assert.equal(model.state, 'error')
  assert.match(model.message, /找不到/)
  assert.equal(server.requests.length, 0)
})

test('演示模式不联网、不需要登录', async () => {
  const { service, server } = setup()
  const model = await service.loadWidgetModel('"demo"')
  assert.equal(model.state, 'ok')
  assert.equal(server.requests.length, 0)
  assert.equal(model.view.bars.length, 14)
})
