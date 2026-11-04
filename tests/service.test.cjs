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
  assert.ok(server.requests.length <= 4, `实际 ${server.requests.length} 次`)
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

test('风控（RK008）和新设备（4006）同样立即停止，且绝不自动发短信', async () => {
  for (const [code, kind] of [['RK008', 'risk'], ['4006', 'device']]) {
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
  assert.equal(loadSettings().tier2, 0)
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
