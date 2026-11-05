'use strict'
// 详情页的状态和流程。用的是假组件，不能代替在手机上看真实效果。
const test = require('node:test')
const assert = require('node:assert/strict')
const { fake, expand, texts, findAll } = require('./support/fake-ui.cjs')
const { resetStores } = require('./support/shim.cjs')

const { DetailPage, loadDetailState } = require('../.build/GridBill/ui/detail')
const { SettingsPage } = require('../.build/GridBill/ui/settings')
const { ACCENT, ACCENT_SOFT } = require('../.build/GridBill/ui/widget-views')
const { SgccClient, SgccError } = require('../.build/GridBill/lib/protocol/client')
const { demoSnapshot } = require('../.build/GridBill/lib/view-model')
const { saveSettings, vault } = require('../.build/GridBill/lib/vault')

const NOW = Date.now()
const PHONE = '13812345678'
const account = (id, tail = '1234') => ({ id, name: '我家', consNo: '', consNoSrc: `110000${tail}`, provinceCode: '11102', orgNo: '111', elecType: '01' })
const bill = (month, kwh = 100, yuan = 50) => ({ month, kwh, yuan, endDay: null })
const BILLS = Array.from({ length: 12 }, (_, i) => bill(i < 2 ? `2025-${11 + i}` : `2026-${String(i - 1).padStart(2, '0')}`, 100 + i, 50 + i))
const snapshotFor = (id, patch = {}) => ({ ...demoSnapshot(NOW), accountId: id, bills: BILLS, ...patch })

function signIn({ accounts = [account('a')], session = true, passwordMd5 = 'x', block = null } = {}) {
  resetStores()
  vault.saveCredentials({ phone: PHONE, passwordMd5 })
  if (session) vault.saveSession({ token: 't', userId: 'u', province: '', expiresAt: Date.now() + 86_400_000 })
  vault.saveAccounts(accounts)
  if (block) vault.saveGate({ block, lastAutoLoginAt: 0 })
}

/** 真的保存状态的 useState，页面才能走完流程。 */
function mount(initial = loadDetailState()) {
  const slots = []
  let cursor = 0
  const original = fake.useState
  fake.useState = value => {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof value === 'function' ? value() : value
    return [slots[index], next => { slots[index] = next }]
  }
  const tree = () => {
    cursor = 0
    return expand(createElement(DetailPage, { initial }))
  }
  return { tree, restore: () => { fake.useState = original } }
}

const render = () => {
  const page = mount()
  try {
    return page.tree()
  } finally {
    page.restore()
  }
}
/** 页眉页脚放在 Section 的属性里，不在子节点里，要单独取。 */
const allText = tree =>
  [
    ...texts(tree),
    ...findAll(tree, 'Section')
      .flatMap(section => [section.props.header, section.props.footer])
      .filter(Boolean)
      .flatMap(node => texts(expand(node))),
  ].join(' ')
const button = (tree, title) => findAll(tree, 'Button').find(node => node.props.title === title)
const row = (tree, title) => findAll(tree, 'LabeledContent').find(node => node.props.title === title)?.props.value
const toolbarOf = tree => findAll(tree, 'List')[0].props.toolbar

/** 替换协议客户端的方法，流程不联网也能走完。返回还原函数。 */
function stubClient(methods) {
  const originals = {}
  for (const [name, method] of Object.entries(methods)) {
    originals[name] = SgccClient.prototype[name]
    SgccClient.prototype[name] = method
  }
  return () => Object.assign(SgccClient.prototype, originals)
}

/** 记录 present 打开了什么；during 模拟用户在那个页面里做的事。 */
function spyPresent(during = () => {}) {
  const shown = []
  const original = fake.Navigation.present
  fake.Navigation.present = async element => {
    shown.push(element)
    during()
  }
  return { shown, restore: () => { fake.Navigation.present = original } }
}

test('打开脚本先显示详情页，关掉后刷新小组件并退出', async () => {
  resetStores()
  const order = []
  const spy = spyPresent(() => order.push('present'))
  const originals = { reloadAll: fake.Widget.reloadAll, exit: fake.Script.exit }
  fake.Widget.reloadAll = () => order.push('reload')
  fake.Script.exit = () => order.push('exit')
  try {
    require('../.build/GridBill/index')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(spy.shown[0].type, DetailPage)
    assert.deepEqual(order, ['present', 'reload', 'exit'])
  } finally {
    fake.Widget.reloadAll = originals.reloadAll
    fake.Script.exit = originals.exit
    spy.restore()
  }
})

test('打开页面不联网，正常状态下显示余额、本月和档位', () => {
  signIn()
  vault.saveSnapshot(snapshotFor('a', { yearEstimateKwh: 4700 }))
  const original = fake.fetch
  let requests = 0
  fake.fetch = async () => {
    requests++
    throw new Error('不该联网')
  }
  try {
    const tree = render()
    const all = allText(tree)
    assert.match(all, /账户余额/)
    assert.match(all, /88\.35/)
    assert.match(all, /我家 · 更新/)
    assert.match(all, /第二档/)
    assert.match(all, /天后进第三档/)
    assert.match(row(tree, '本月'), /^137 度 · 约 [\d.]+ 元$/)
    assert.equal(row(tree, '今年累计'), '4,700 度')
    assert.equal(findAll(tree, 'ProgressView').length, 3, '阶梯条')
    assert.equal(requests, 0)
  } finally {
    fake.fetch = original
  }
})

test('界面上不能出现完整手机号和户号', () => {
  signIn({ accounts: [account('a', '1234'), account('b', '5678')] })
  vault.saveSnapshot(snapshotFor('a'))
  const json = JSON.stringify(render())
  assert.ok(!json.includes(PHONE))
  assert.ok(!json.includes('1100001234'))
  assert.ok(json.includes('****1234'))
})

test('每日图表：日期轴按天，最新一天高亮，虚线是日均', () => {
  signIn()
  vault.saveSnapshot(snapshotFor('a'))
  const tree = render()
  assert.equal(findAll(tree, 'Chart').length, 2, '每日和月度各一个')
  const { marks } = findAll(tree, 'BarChart')[0].props
  assert.equal(marks.length, 21, '演示数据有 21 天，全部显示')
  const first = marks[0]
  assert.ok(first.label instanceof Date)
  assert.equal(first.unit, 'day')
  assert.equal(first.foregroundStyle, ACCENT_SOFT)
  assert.equal(marks[20].foregroundStyle, ACCENT)
  // 手机时区的当天零点，不管手机在哪个时区柱子都落在正确的日子上。
  assert.equal(first.label.getHours(), 0)
  const day = demoSnapshot(NOW).daily[0].day
  assert.equal(`${first.label.getFullYear()}-${String(first.label.getMonth() + 1).padStart(2, '0')}-${String(first.label.getDate()).padStart(2, '0')}`, day)

  const rule = findAll(tree, 'RuleLineForValueChart')[0].props.marks[0]
  const average = marks.reduce((total, mark) => total + mark.value, 0) / marks.length
  assert.ok(Math.abs(rule.value - average) < 1e-9)
  assert.match(allText(tree), /最近 21 天/)
  assert.match(allText(tree), /虚线是日均/)
  assert.match(row(tree, '日均'), /度$/)
  assert.match(row(tree, '最高'), /^\d+\/\d+ · [\d.]+ 度$/)
})

test('每日图表：读数太少时不画日均线，没有读数时显示提示', () => {
  signIn()
  vault.saveSnapshot(snapshotFor('a', { daily: [{ day: '2026-11-02', kwh: 14, yuan: null }, { day: '2026-11-03', kwh: 13, yuan: null }] }))
  const few = render()
  assert.equal(findAll(few, 'RuleLineForValueChart').length, 0)
  assert.equal(row(few, '日均'), undefined)
  assert.doesNotMatch(allText(few), /虚线/)
  assert.match(allText(few), /最近 2 天/)

  vault.saveSnapshot(snapshotFor('a', { daily: [] }))
  const none = render()
  assert.equal(findAll(none, 'Chart').length, 1, '只剩月度图')
  assert.match(allText(none), /暂无每日数据/)
  assert.equal(row(none, '最高'), undefined)
})

test('月度账单：图表和列表都有 12 个月，列表最新的在前', () => {
  signIn()
  vault.saveSnapshot(snapshotFor('a'))
  const tree = render()
  const { marks } = findAll(tree, 'BarChart')[1].props
  assert.equal(marks.length, 12)
  assert.equal(marks[0].label, '11月')
  assert.equal(marks[11].label, '10月')
  assert.equal(marks[11].foregroundStyle, ACCENT)
  assert.equal(marks[11].value, 111)
  assert.equal(row(tree, '10月'), '111 度 · 61.00 元')
  assert.equal(row(tree, '2025年11月'), '100 度 · 50.00 元')
  const titles = findAll(tree, 'LabeledContent').map(node => node.props.title)
  assert.ok(titles.indexOf('10月') < titles.indexOf('1月'))
  assert.ok(titles.indexOf('1月') < titles.indexOf('2025年12月'))
  assert.match(row(tree, '今年已出账'), /度 · [\d.]+ 元$/)
  assert.doesNotMatch(allText(tree), /补满 12 个月/, '已经满了就不用提示')
})

test('月度账单：不满 12 个月时提示可以补，旧快照先显示上期账单', () => {
  signIn()
  vault.saveSnapshot(snapshotFor('a', { bills: undefined }))
  const tree = render()
  assert.match(allText(tree), /补满 12 个月/)
  assert.equal(findAll(tree, 'BarChart')[1].props.marks.length, 1)
})

test('月度账单：完全没有账单时显示提示，不画空图', () => {
  signIn()
  vault.saveSnapshot(snapshotFor('a', { bills: [], lastBill: null, yearKwh: null, yearYuan: null }))
  const tree = render()
  assert.equal(findAll(tree, 'Chart').length, 1, '只剩每日图')
  assert.match(allText(tree), /暂无账单/)
  assert.equal(row(tree, '今年已出账'), undefined)
})

test('还没有查过数据时，提示点立即刷新，不显示空图', () => {
  signIn()
  const tree = render()
  assert.match(allText(tree), /还没有数据/)
  assert.equal(findAll(tree, 'Chart').length, 0)
  assert.equal(button(tree, '立即刷新').props.disabled, false)
})

test('账号没有绑定户号时明确告知，不能刷新', () => {
  signIn({ accounts: [] })
  const tree = render()
  assert.match(allText(tree), /没有绑定户号/)
  assert.ok(button(tree, '立即刷新').props.disabled)
})

test('被闸门拦下时：说明原因、提供入口、不能刷新，已有数据继续显示', () => {
  signIn({ block: { kind: 'risk', message: '国网安全校验未通过（RK008）', at: 1 } })
  vault.saveSnapshot(snapshotFor('a'))
  const tree = render()
  assert.match(allText(tree), /已暂停自动更新：国网安全校验未通过（RK008）/)
  assert.ok(button(tree, '去设置处理'))
  assert.ok(button(tree, '立即刷新').props.disabled)
  assert.match(allText(tree), /88\.35/)
  assert.equal(findAll(tree, 'Chart').length, 2)
})

test('只用验证码登录过且已到期时：提示重新登录，不能刷新，已有数据继续显示', () => {
  signIn({ session: false, passwordMd5: null })
  vault.saveSnapshot(snapshotFor('a'))
  const tree = render()
  assert.match(allText(tree), /登录已过期/)
  assert.ok(button(tree, '去设置处理'))
  assert.ok(button(tree, '立即刷新').props.disabled)
  assert.match(allText(tree), /88\.35/)
})

test('有密码时会话到期也能刷新，到时自动续', () => {
  signIn({ session: false, passwordMd5: 'x' })
  vault.saveSnapshot(snapshotFor('a'))
  const tree = render()
  assert.doesNotMatch(allText(tree), /登录已过期/)
  assert.equal(button(tree, '去设置处理'), undefined)
  assert.equal(button(tree, '立即刷新').props.disabled, false)
})

test('工具栏：完成关闭页面，设置打开设置页', async () => {
  signIn()
  const original = fake.Navigation.useDismiss
  let dismissed = 0
  fake.Navigation.useDismiss = () => () => { dismissed++ }
  const spy = spyPresent()
  const page = mount()
  try {
    const { cancellationAction, topBarTrailing } = toolbarOf(page.tree())
    assert.equal(cancellationAction.props.title, '完成')
    cancellationAction.props.action()
    assert.equal(dismissed, 1)
    assert.equal(topBarTrailing.props.title, '设置')
    assert.equal(topBarTrailing.props.systemImage, 'gearshape')
    await topBarTrailing.props.action()
    assert.equal(spy.shown.length, 1)
    assert.equal(spy.shown[0].type, SettingsPage)
  } finally {
    fake.Navigation.useDismiss = original
    spy.restore()
    page.restore()
  }
})

test('没登录时只有登录入口；在设置页登录后回来就显示数据', async () => {
  resetStores()
  const spy = spyPresent(() => {
    vault.saveCredentials({ phone: PHONE, passwordMd5: 'x' })
    vault.saveSession({ token: 't', userId: 'u', province: '', expiresAt: Date.now() + 86_400_000 })
    vault.saveAccounts([account('a')])
    vault.saveSnapshot(snapshotFor('a'))
  })
  const page = mount()
  try {
    const before = page.tree()
    assert.match(allText(before), /还没有登录/)
    assert.equal(findAll(before, 'Chart').length, 0)
    assert.equal(button(before, '立即刷新'), undefined)
    assert.ok(toolbarOf(before).topBarTrailing, '没登录也要能进设置，预览小组件在那里')
    await button(before, '去登录').props.action()
    assert.equal(spy.shown[0].type, SettingsPage)
    const after = page.tree()
    assert.doesNotMatch(allText(after), /还没有登录/)
    assert.match(allText(after), /88\.35/)
  } finally {
    spy.restore()
    page.restore()
  }
})

test('在设置页退出登录后回来，显示登录入口，不留下旧数据', async () => {
  signIn()
  vault.saveSnapshot(snapshotFor('a'))
  const spy = spyPresent(() => resetStores())
  const page = mount()
  try {
    await toolbarOf(page.tree()).topBarTrailing.props.action()
    const tree = page.tree()
    assert.match(allText(tree), /还没有登录/)
    assert.doesNotMatch(allText(tree), /88\.35/)
  } finally {
    spy.restore()
    page.restore()
  }
})

test('在设置页改了阶梯或默认户号，回来就生效', async () => {
  signIn({ accounts: [account('a', '1234'), account('b', '5678')] })
  vault.saveSnapshot(snapshotFor('a'))
  vault.saveSnapshot(snapshotFor('b', { balance: { isPrepaid: true, balance: 12.5, amountDue: null, overdue: null } }))
  const spy = spyPresent(() => saveSettings({ accountId: 'a', names: {}, tier2: 100, tier3: 200, price1: 1, price2: 2, price3: 3, chartDays: 14, refreshHours: 12 }))
  const page = mount()
  try {
    assert.doesNotMatch(allText(page.tree()), /第三档/)
    await toolbarOf(page.tree()).topBarTrailing.props.action()
    assert.match(allText(page.tree()), /第三档/)
  } finally {
    spy.restore()
    page.restore()
  }
})

test('多个户号：可以切换查看，只读已保存的数据，不联网', () => {
  signIn({ accounts: [account('a', '1234'), account('b', '5678')] })
  vault.saveSnapshot(snapshotFor('a'))
  vault.saveSnapshot(snapshotFor('b', { balance: { isPrepaid: true, balance: 12.5, amountDue: null, overdue: null } }))
  const page = mount()
  try {
    const picker = () => findAll(page.tree(), 'Picker')[0]
    assert.equal(picker().props.value, 'a')
    assert.match(allText(page.tree()), /88\.35/)
    picker().props.onChanged('b')
    assert.equal(picker().props.value, 'b')
    assert.match(allText(page.tree()), /12\.50/)
    assert.doesNotMatch(allText(page.tree()), /88\.35/)
  } finally {
    page.restore()
  }
})

test('多个户号：没查过的户号提示刷新，切换不影响设置里的默认户号', () => {
  signIn({ accounts: [account('a', '1234'), account('b', '5678')] })
  vault.saveSnapshot(snapshotFor('a'))
  const page = mount()
  try {
    findAll(page.tree(), 'Picker')[0].props.onChanged('b')
    assert.match(allText(page.tree()), /还没有数据/)
    assert.equal(loadDetailState().account.id, 'a')
  } finally {
    page.restore()
  }
})

test('只有一个户号时不显示切换', () => {
  signIn()
  vault.saveSnapshot(snapshotFor('a'))
  assert.equal(findAll(render(), 'Picker').length, 0)
})

const QUERIES = (years = []) => ({
  async dailyUsage() {
    return { readings: [{ day: '2026-11-03', kwh: 77, yuan: null }], totalKwh: 77 }
  },
  async monthlyBills(session, item, year) {
    years.push(year)
    return { bills: [bill(`${year}-10`, 300, 150)], kwh: 300, yuan: 150 }
  },
  async balance() {
    return { isPrepaid: true, balance: 66.6, amountDue: null, overdue: null }
  },
})

test('立即刷新：会补去年的账单，保存后页面显示新数据，小组件也跟着更新', async () => {
  signIn()
  const years = []
  const restoreClient = stubClient(QUERIES(years))
  const originalReload = fake.Widget.reloadAll
  let reloads = 0
  fake.Widget.reloadAll = () => { reloads++ }
  const page = mount()
  try {
    assert.match(allText(page.tree()), /还没有数据/)
    await button(page.tree(), '立即刷新').props.action()
    assert.ok(years.includes(new Date().getFullYear() - 1), '详情页的刷新要带上去年的账单')
    assert.equal(reloads, 1)
    const tree = page.tree()
    assert.match(allText(tree), /已更新/)
    assert.match(allText(tree), /66\.60/)
    assert.equal(button(tree, '立即刷新').props.disabled, false, '刷新完可以再点')
    assert.equal(vault.snapshot('a').balance.balance, 66.6)
  } finally {
    fake.Widget.reloadAll = originalReload
    restoreClient()
    page.restore()
  }
})

test('立即刷新：失败时显示原因，已有数据不变', async () => {
  signIn()
  vault.saveSnapshot(snapshotFor('a'))
  const restoreClient = stubClient({
    async dailyUsage() {
      throw new SgccError('network', 'transport', '连不上国网服务器')
    },
  })
  const page = mount()
  try {
    await button(page.tree(), '立即刷新').props.action()
    const tree = page.tree()
    assert.match(allText(tree), /连不上国网服务器/)
    assert.doesNotMatch(allText(tree), /已更新/)
    assert.match(allText(tree), /88\.35/)
    assert.equal(button(tree, '立即刷新').props.disabled, false)
  } finally {
    restoreClient()
    page.restore()
  }
})

test('立即刷新：被风控拦下时显示代码和暂停提示，不能再点', async () => {
  signIn()
  vault.saveSnapshot(snapshotFor('a'))
  const restoreClient = stubClient({
    async dailyUsage() {
      throw new SgccError('risk', 'RK008', '国网安全校验未通过（RK008）')
    },
  })
  const page = mount()
  try {
    await button(page.tree(), '立即刷新').props.action()
    const tree = page.tree()
    assert.match(allText(tree), /不要反复重试/)
    assert.match(allText(tree), /已暂停自动更新/)
    assert.ok(button(tree, '立即刷新').props.disabled)
    assert.ok(button(tree, '去设置处理'))
  } finally {
    restoreClient()
    page.restore()
  }
})

test('立即刷新：刷新中不能重复点，也不能进设置', async () => {
  signIn()
  let finish
  let dailyCalls = 0
  const empty = { readings: [], totalKwh: null }
  const restoreClient = stubClient({
    ...QUERIES(),
    // 只让第一次查询停住：读数不够 30 天时还会接着查上个月。
    dailyUsage: () => (dailyCalls++ > 0 ? Promise.resolve(empty) : new Promise(resolve => { finish = () => resolve(empty) })),
  })
  const page = mount()
  try {
    const running = button(page.tree(), '立即刷新').props.action()
    await new Promise(resolve => setImmediate(resolve))
    const during = page.tree()
    const busyButton = button(during, '处理中…')
    assert.ok(busyButton.props.disabled)
    assert.ok(toolbarOf(during).topBarTrailing.props.disabled)
    await busyButton.props.action()
    finish()
    await running
    assert.ok(button(page.tree(), '立即刷新'))
  } finally {
    restoreClient()
    page.restore()
  }
})

test('默认打开设置里选的户号，选的户号没了就用第一个', () => {
  signIn({ accounts: [account('a', '1234'), account('b', '5678')] })
  saveSettings({ accountId: 'b', names: {}, tier2: 2880, tier3: 4800, price1: 1, price2: 2, price3: 3, chartDays: 14, refreshHours: 12 })
  assert.equal(loadDetailState().account.id, 'b')
  assert.equal(loadDetailState('a').account.id, 'a', '页面上切换过就用切换的')
  saveSettings({ accountId: 'gone', names: {}, tier2: 2880, tier3: 4800, price1: 1, price2: 2, price3: 3, chartDays: 14, refreshHours: 12 })
  assert.equal(loadDetailState().account.id, 'a')
})
