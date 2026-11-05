'use strict'
// UI 冒烟测试：确认组件在各种状态下都能渲染、不抛错、显示对的内容。
// 用的是假组件，不能代替在手机上看真实效果。
const test = require('node:test')
const assert = require('node:assert/strict')
const { fake, expand, texts, findAll } = require('./support/fake-ui.cjs')
const { resetStores } = require('./support/shim.cjs')

const { WidgetRoot, amountFontSize } = require('../.build/GridBill/ui/widget-views')
const { SettingsPage, describeError, loadInitialState } = require('../.build/GridBill/ui/settings')
const { SgccClient, SgccError } = require('../.build/GridBill/lib/protocol/client')
const { buildBillView, demoSnapshot } = require('../.build/GridBill/lib/view-model')
const { DEFAULT_SETTINGS } = require('../.build/GridBill/lib/types')
const { loadSettings, vault } = require('../.build/GridBill/lib/vault')

const ACCOUNT = { id: 'a', name: '张*', consNo: '', consNoSrc: '1100001234', provinceCode: '', orgNo: '', elecType: '01' }
const NOW = Date.UTC(2026, 10, 4)
const next = new Date(NOW)
const demoView = (settings = {}, notice = null) => buildBillView(demoSnapshot(NOW), ACCOUNT, { ...DEFAULT_SETTINGS, ...settings }, notice)
const render = (model, family = 'systemMedium', size = { width: 338, height: 158 }) => {
  fake.Widget.family = family
  fake.Widget.displaySize = size
  return expand(createElement(WidgetRoot, { model }))
}

for (const [family, size] of [['systemMedium', { width: 338, height: 158 }], ['systemSmall', { width: 158, height: 158 }]]) {
  test(`${family}：显示关键信息，背景用 widgetBackground`, () => {
    const tree = render({ state: 'ok', view: demoView(), nextRefresh: next }, family, size)
    const all = texts(tree).join(' ')
    assert.match(all, /张\*/)
    assert.match(all, /账户余额/)
    assert.match(all, /88\.35/)
    assert.match(all, /137/)
    assert.ok(tree.props.widgetBackground, '根节点要设置 widgetBackground，着色模式才不会变白')
  })

  test(`${family}：柱子数量对，宽度弹性、高度不超过图表`, () => {
    for (const chartDays of [7, 14, 21]) {
      const tree = render({ state: 'ok', view: demoView({ chartDays }), nextRefresh: next }, family, size)
      const bars = findAll(tree, 'RoundedRectangle')
      assert.equal(bars.length, chartDays)
      for (const bar of bars) {
        assert.equal(bar.props.frame.maxWidth, 'infinity', '不写死宽度')
        assert.equal(bar.props.frame.width, undefined)
        assert.equal(bar.props.frame.minHeight, bar.props.frame.maxHeight, '高度固定')
        assert.ok(bar.props.frame.maxHeight >= 2 && bar.props.frame.maxHeight <= 52)
      }
    }
  })

  test(`${family}：默认画三段阶梯和本月电费，档位设置不对时都不画`, () => {
    const off = render({ state: 'ok', view: demoView({ tier2: 0, tier3: 0 }), nextRefresh: next }, family, size)
    assert.equal(findAll(off, 'ProgressView').length, 0)
    assert.doesNotMatch(texts(off).join(' '), /约 /)
    const on = render({ state: 'ok', view: demoView(), nextRefresh: next }, family, size)
    assert.match(texts(on).join(' '), /约 67\.09 元/)
    const segments = findAll(on, 'ProgressView')
    assert.equal(segments.length, 3)
    assert.equal(segments[0].props.progressViewStyle, 'linear')
    assert.ok(segments[0].props.value > 0 && segments[0].props.value <= segments[0].props.total)
  })

  test(`${family}：提示文字会替换更新时间`, () => {
    const all = texts(render({ state: 'ok', view: demoView({}, '密码被拒绝，需要重新登录'), nextRefresh: next }, family, size)).join(' ')
    assert.match(all, /重新登录/)
    assert.doesNotMatch(all, /更新 /)
  })

  test(`${family}：frame 不混用固定和弹性两种写法（官方文档要求）`, () => {
    const tree = render({ state: 'ok', view: demoView({ tier2: 2880, tier3: 4800 }), nextRefresh: next }, family, size)
    const walk = node => {
      if (!node || typeof node !== 'object') return
      const { frame } = node.props
      if (frame) {
        const fixed = 'width' in frame || 'height' in frame
        const flexible = ['minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'idealWidth', 'idealHeight'].some(key => key in frame)
        assert.ok(!(fixed && flexible), JSON.stringify(frame))
      }
      node.children.forEach(walk)
    }
    walk(tree)
  })
}

test('读数很少时柱子不会变粗：前面补细线占满格数', () => {
  const days = ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']
  const snapshot = { ...demoSnapshot(NOW), daily: days.map(day => ({ day, kwh: 14, yuan: null })) }
  const view = buildBillView(snapshot, ACCOUNT, DEFAULT_SETTINGS, null)
  const shapes = findAll(render({ state: 'ok', view, nextRefresh: next }), 'RoundedRectangle')
  assert.equal(shapes.length, 14, '格数固定，宽度才固定')
  const placeholders = shapes.filter(shape => String(shape.props.key).startsWith('empty-'))
  assert.equal(placeholders.length, 10)
  assert.ok(placeholders.every(shape => shape.props.frame.maxHeight === 2))
  assert.equal(shapes.slice(0, 10).every(shape => String(shape.props.key).startsWith('empty-')), true, '占位在前，最新一天靠右')
  assert.equal(shapes[13].props.widgetAccentable, true)
})

test('金额越长字号越小', () => {
  assert.equal(amountFontSize('88.35', 28), 28)
  assert.equal(amountFontSize('326.80', 28), 28)
  assert.equal(amountFontSize('1280.50', 28), 24)
  assert.equal(amountFontSize('12345.67', 28), 20)
})

test('余额缺失时不显示“元”', () => {
  const snapshot = { ...demoSnapshot(NOW), balance: null }
  const view = buildBillView(snapshot, ACCOUNT, DEFAULT_SETTINGS, null)
  const all = texts(render({ state: 'ok', view, nextRefresh: next }))
  assert.ok(all.includes('--'))
  assert.ok(!all.includes('元'))
  assert.match(all.join(' '), /账单 [\d.]+ 元/, '上期账单不受影响')
})

const SNAPSHOT_NOW = (patch = {}) => ({ ...demoSnapshot(NOW), ...patch })
const mediumTree = (patch = {}, settings = {}) => render({ state: 'ok', view: buildBillView(SNAPSHOT_NOW(patch), ACCOUNT, { ...DEFAULT_SETTINGS, ...settings }, null), nextRefresh: next })
const textNode = (tree, pattern) => findAll(tree, 'Text').find(node => pattern.test(texts(node).join(' ')))

test('中号：图表下面有起始日期、日均和最新一天的读数', () => {
  const all = texts(mediumTree()).join(' ')
  assert.match(all, /10\/21/, '演示数据最新是 11/3，往前数 14 格')
  assert.match(all, /日均 [\d.]+ 度/)
  assert.match(all, /11\/3 [\d.]+ 度/)
})

test('中号：本月用电在图表上面，今年累计和档位在最下面', () => {
  const all = texts(mediumTree()).join(' ')
  assert.match(all, /本月 137 度/)
  assert.match(all, /今年 2,315 度 · 第一档/)
  assert.ok(all.indexOf('本月 137 度') < all.indexOf('今年 2,315 度'))
})

test('中号：快到下一档时提示醒目，还远时只是普通文字', () => {
  const near = textNode(mediumTree({ yearEstimateKwh: 4700 }), /天后进第三档/)
  assert.equal(near.props.fontWeight, 'semibold')
  assert.equal(typeof near.props.foregroundStyle, 'object', '用区分深浅色的橙色')
  const far = textNode(mediumTree({ yearEstimateKwh: 3000 }), /距第三档/)
  assert.equal(far.props.fontWeight, 'regular')
  assert.equal(far.props.foregroundStyle, 'secondaryLabel')
})

test('中号：左边一栏靠左对齐，不会被 frame 默认居中', () => {
  const column = findAll(mediumTree(), 'VStack').find(node => node.props.frame?.width !== undefined)
  assert.equal(column.props.frame.alignment, 'leading')
})

test('中号：柱子高度随机型伸缩，其他元素高度固定', () => {
  for (const [size, expected] of [[{ width: 292, height: 141 }, 31], [{ width: 338, height: 158 }, 48], [{ width: 360, height: 169 }, 52], [{ width: 280, height: 130 }, 28]]) {
    const tree = render({ state: 'ok', view: demoView(), nextRefresh: next }, 'systemMedium', size)
    const tallest = Math.max(...findAll(tree, 'RoundedRectangle').map(bar => bar.props.frame.maxHeight))
    assert.equal(Math.round(tallest), expected, `${size.width}×${size.height}`)
  }
})

test('中号：档位设置不对时不画阶梯条，但今年累计还在', () => {
  const tree = mediumTree({}, { tier2: 0, tier3: 0 })
  assert.equal(findAll(tree, 'ProgressView').length, 0)
  assert.match(texts(tree).join(' '), /今年 2,315 度/)
  assert.doesNotMatch(texts(tree).join(' '), /第一档/)
})

test('中号：缺数据时显示 --，不带单位，也不留空白', () => {
  const all = texts(mediumTree({ monthKwh: null, yearEstimateKwh: null, yearKwh: null, lastBill: null, balance: null, daily: [] })).join(' ')
  assert.match(all, /本月 --/)
  assert.match(all, /今年 --/)
  assert.match(all, /上期账单 --/)
  assert.match(all, /暂无每日数据/)
  assert.match(all, /每日数据通常延迟一两天/)
  assert.doesNotMatch(all, /-- (度|元)/)
  assert.doesNotMatch(all, /日均/)
})

test('中号：上期账单的金额缺失时不带“元”', () => {
  const all = texts(mediumTree({ lastBill: { month: '2026-10', kwh: 100, yuan: null, endDay: null } })).join(' ')
  assert.match(all, /10月账单 --/)
  assert.doesNotMatch(all, /-- 元/)
})

test('中号：读数只有两天时不显示日均，也不预估', () => {
  const daily = [{ day: '2026-11-02', kwh: 14, yuan: null }, { day: '2026-11-03', kwh: 13, yuan: null }]
  const all = texts(mediumTree({ daily, yearEstimateKwh: 4700 })).join(' ')
  assert.doesNotMatch(all, /日均/)
  assert.doesNotMatch(all, /天后进/)
  assert.match(all, /距第三档 100 度/)
})

test('没有每日数据时显示提示而不是空白', () => {
  const view = buildBillView({ ...demoSnapshot(NOW), daily: [] }, ACCOUNT, DEFAULT_SETTINGS, null)
  assert.match(texts(render({ state: 'ok', view, nextRefresh: next })).join(' '), /暂无每日数据/)
})

test('未登录、出错、不支持的尺寸都有明确提示', () => {
  assert.match(texts(render({ state: 'signedOut', nextRefresh: next })).join(' '), /还没有登录/)
  assert.match(texts(render({ state: 'error', message: '找不到户号', nextRefresh: next })).join(' '), /找不到户号/)
  assert.match(texts(render({ state: 'ok', view: demoView(), nextRefresh: next }, 'systemLarge')).join(' '), /不支持这个尺寸/)
})

const renderSettings = () => expand(createElement(SettingsPage, { initial: loadInitialState() }))
const titles = tree => [...findAll(tree, 'Button'), ...findAll(tree, 'TextField'), ...findAll(tree, 'SecureField')].map(node => node.props.title)
const button = (tree, title) => findAll(tree, 'Button').find(b => b.props.title === title)

test('设置页：未登录时显示登录表单，短信按钮只在国网要求时才出现', () => {
  resetStores()
  const tree = renderSettings()
  const names = titles(tree)
  assert.ok(names.includes('手机号'))
  assert.ok(names.includes('密码'))
  assert.ok(names.includes('登录'))
  assert.ok(!names.includes('发送验证码'))
  assert.ok(button(tree, '立即刷新').props.disabled, '未登录不能刷新')
  assert.ok(button(tree, '登录').props.disabled, '没填内容不能登录')
})

test('设置页：所有输入框外面都有可见的标题', () => {
  resetStores()
  vault.saveCredentials({ phone: '13812345678', passwordMd5: 'x' })
  vault.saveAccounts([ACCOUNT])
  vault.saveGate({ block: { kind: 'device', message: 'm', at: 1 }, lastAutoLoginAt: 0 })
  const tree = renderSettings()
  const labeled = findAll(tree, 'LabeledContent')
  const wrapped = labeled.flatMap(node => [...findAll(node, 'TextField'), ...findAll(node, 'SecureField')])
  const all = [...findAll(tree, 'TextField'), ...findAll(tree, 'SecureField')]
  assert.ok(all.length >= 5)
  assert.equal(wrapped.length, all.length)
})

test('设置页：已登录时隐藏表单，账号打码', () => {
  resetStores()
  vault.saveCredentials({ phone: '13812345678', passwordMd5: 'x' })
  vault.saveSession({ token: 't', userId: 'u', province: '', expiresAt: Date.now() + 86400000 })
  vault.saveAccounts([ACCOUNT])
  const tree = renderSettings()
  const names = titles(tree)
  assert.ok(!names.includes('密码'))
  assert.ok(names.includes('重新登录'))
  assert.equal(findAll(tree, 'LabeledContent').find(n => n.props.title === '账号').props.value, '****5678')
  assert.equal(button(tree, '立即刷新').props.disabled, false)
  assert.ok(findAll(tree, 'Picker').length >= 3, '默认户号、刷新间隔、柱状图天数')
  assert.ok(!JSON.stringify(tree).includes('13812345678'), '界面上不能出现完整手机号')
})

test('设置页：户号列表不显示加密户名，已登录时有诊断按钮', () => {
  resetStores()
  vault.saveCredentials({ phone: '13812345678', passwordMd5: 'x' })
  vault.saveSession({ token: 't', userId: 'u', province: '', expiresAt: Date.now() + 86400000 })
  vault.saveAccounts([{ ...ACCOUNT, name: '99:0123456789abcdef0123456789abcdef:02:osg-uc:2601010000:001' }])
  const tree = renderSettings()
  assert.ok(!JSON.stringify(tree).includes('osg-uc'))
  assert.equal(button(tree, '诊断每日数据').props.disabled, false)
})

/** 真的保存状态的 useState，用来验证输入框连续输入时的表现。 */
function mountSettings() {
  const slots = []
  let cursor = 0
  const original = fake.useState
  fake.useState = initial => {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], value => { slots[index] = value }]
  }
  const initial = loadInitialState()
  const tree = () => {
    cursor = 0
    return expand(createElement(SettingsPage, { initial }))
  }
  return {
    tree,
    field: title => findAll(tree(), 'TextField').find(node => node.props.title === title),
    restore() {
      fake.useState = original
    },
  }
}

test('设置页：阶梯和单价已经按北京标准填好', () => {
  resetStores()
  const fields = findAll(renderSettings(), 'TextField')
  const value = title => fields.find(node => node.props.title === title).props.value
  assert.equal(value('第二档起点（度/年）'), '2880')
  assert.equal(value('第三档起点（度/年）'), '4800')
  assert.equal(value('第一档电价（元/度）'), '0.4883')
  assert.equal(value('第二档电价（元/度）'), '0.5383')
  assert.equal(value('第三档电价（元/度）'), '0.7883')
})

test('设置页：单价能一个字一个字地输入，“0.”不会被吞掉；清空后恢复默认', () => {
  resetStores()
  const page = mountSettings()
  try {
    const TITLE = '第一档电价（元/度）'
    assert.equal(page.field(TITLE).props.keyboardType, 'decimalPad')
    for (const text of ['0', '0.', '0.5', '0.52']) {
      page.field(TITLE).props.onChanged(text)
      assert.equal(page.field(TITLE).props.value, text, `输入 ${text} 之后不能被改写`)
    }
    assert.equal(loadSettings().price1, 0.52)
    page.field(TITLE).props.onChanged('')
    assert.equal(page.field(TITLE).props.value, '')
    assert.equal(loadSettings().price1, 0.4883)
  } finally {
    page.restore()
  }
})

test('设置页：显示脚本版本和远程来源，方便确认手机上跑的是哪个版本', () => {
  resetStores()
  const row = (tree, title) => findAll(tree, 'LabeledContent').find(node => node.props.title === title).props.value
  assert.equal(row(renderSettings(), '脚本版本'), '9.9.9')
  assert.equal(row(renderSettings(), '远程来源'), '未设置')
  const original = fake.Script.metadata
  fake.Script.metadata = { version: '9.9.9', remoteResource: { url: 'https://github.com/owner/repository' } }
  try {
    assert.equal(row(renderSettings(), '远程来源'), '已设置')
  } finally {
    fake.Script.metadata = original
  }
})

test('错误提示：风控不让人“请重试”，并写明具体代码', () => {
  for (const code of ['RK007', 'RK008']) {
    const text = describeError(new SgccError('risk', code, 'x'))
    assert.ok(text.includes(code))
    assert.match(text, /不要反复重试/)
    assert.doesNotMatch(text, /，请重试。/)
  }
  assert.doesNotMatch(describeError(new SgccError('risk', 'blocked', 'x')), /blocked/, '被闸门拦下时没有 RK 代码可显示')
})

/** 已登录且会话有效的状态。 */
function signedInStores() {
  resetStores()
  vault.saveCredentials({ phone: '13812345678', passwordMd5: 'x' })
  vault.saveSession({ token: 't', userId: 'u', province: '', expiresAt: Date.now() + 86400000 })
  vault.saveAccounts([ACCOUNT])
}

test('设置页：登录还有效时，重新登录要先确认；不确认就不显示表单', async () => {
  signedInStores()
  const page = mountSettings()
  const original = globalThis.Dialog.confirm
  try {
    const shown = []
    globalThis.Dialog.confirm = async options => {
      shown.push(options)
      return false
    }
    await button(page.tree(), '重新登录').props.action()
    assert.equal(shown.length, 1)
    assert.match(shown[0].message, /通常不需要重新登录/)
    assert.ok(!titles(page.tree()).includes('密码'), '取消后不显示表单')

    globalThis.Dialog.confirm = async () => true
    await button(page.tree(), '重新登录').props.action()
    assert.ok(titles(page.tree()).includes('密码'))
  } finally {
    globalThis.Dialog.confirm = original
    page.restore()
  }
})

test('设置页：重新登录的表单可以取消，取消后手机号不再显示', async () => {
  signedInStores()
  const page = mountSettings()
  try {
    await button(page.tree(), '重新登录').props.action()
    assert.ok(JSON.stringify(page.tree()).includes('13812345678'), '表单里要能看到手机号')
    button(page.tree(), '取消').props.action()
    const after = page.tree()
    assert.ok(!titles(after).includes('密码'))
    assert.ok(titles(after).includes('重新登录'))
    assert.ok(!JSON.stringify(after).includes('13812345678'))
  } finally {
    page.restore()
  }
})

test('设置页：重新登录途中闸门关上了，就不能再取消', async () => {
  signedInStores()
  const page = mountSettings()
  try {
    await button(page.tree(), '重新登录').props.action()
    assert.ok(titles(page.tree()).includes('取消'))
    vault.saveGate({ block: { kind: 'risk', message: 'm', at: 1 }, lastAutoLoginAt: 0 })
    // 没填密码，这次点击在联网之前就会失败，页面借此读到新的闸门状态。
    await button(page.tree(), '登录').props.action()
    assert.ok(!titles(page.tree()).includes('取消'))
  } finally {
    page.restore()
  }
})

test('设置页：还没登录时直接显示表单，没有取消按钮', () => {
  resetStores()
  assert.ok(!titles(renderSettings()).includes('取消'))
})

test('设置页：被闸门拦下时提示并要求重新登录', () => {
  resetStores()
  vault.saveCredentials({ phone: '13812345678', passwordMd5: 'x' })
  vault.saveAccounts([ACCOUNT])
  vault.saveGate({ block: { kind: 'credentials', message: '密码错误', at: 1 }, lastAutoLoginAt: 0 })
  const tree = renderSettings()
  assert.match(texts(tree).join(' '), /已暂停自动更新/)
  assert.ok(titles(tree).includes('密码'))
  assert.ok(button(tree, '立即刷新').props.disabled)
  assert.ok(!titles(tree).includes('取消'), '闸门关着时不能取消，必须处理')
})

const loginMode = tree => findAll(tree, 'Picker').find(node => node.props.title === '登录方式')

/** 替换协议客户端的方法，界面流程不联网也能走完。返回还原函数。 */
function stubClient(methods) {
  const originals = {}
  for (const [name, method] of Object.entries(methods)) {
    originals[name] = SgccClient.prototype[name]
    SgccClient.prototype[name] = method
  }
  return () => Object.assign(SgccClient.prototype, originals)
}

/** 打开设置页，切到验证码登录并填好手机号。 */
function mountCodeForm() {
  const page = mountSettings()
  loginMode(page.tree()).props.onChanged('code')
  page.field('手机号').props.onChanged('13812345678')
  return page
}

const LOGIN_RESULT = () => ({ session: { token: 't', userId: 'u', province: '', expiresAt: Date.now() + 86400000 }, accounts: [ACCOUNT] })

test('设置页：默认密码登录，切到验证码登录后没有密码框，发过验证码才能登录', async () => {
  resetStores()
  const restoreClient = stubClient({ sendLoginSms: async () => 'key-1' })
  const page = mountSettings()
  try {
    const before = page.tree()
    assert.equal(loginMode(before).props.value, 'password')
    assert.equal(loginMode(before).props.pickerStyle, 'segmented')
    loginMode(before).props.onChanged('code')

    const names = titles(page.tree())
    assert.ok(!names.includes('密码'))
    assert.ok(names.includes('发送验证码'))
    assert.ok(names.includes('短信验证码'))
    assert.ok(button(page.tree(), '发送验证码').props.disabled, '没填手机号不能发')

    page.field('手机号').props.onChanged('13812345678')
    assert.equal(button(page.tree(), '发送验证码').props.disabled, false)
    page.field('短信验证码').props.onChanged('123456')
    assert.ok(button(page.tree(), '登录').props.disabled, '没发过验证码不能登录')

    await button(page.tree(), '发送验证码').props.action()
    assert.match(texts(page.tree()).join(' '), /验证码已发送/)
    assert.equal(button(page.tree(), '登录').props.disabled, false)

    loginMode(page.tree()).props.onChanged('password')
    assert.ok(titles(page.tree()).includes('密码'))
    assert.ok(!titles(page.tree()).includes('发送验证码'), '切回密码登录后短信按钮又只在国网要求时才出现')
  } finally {
    page.restore()
    restoreClient()
  }
})

test('设置页：验证码登录走完整流程，发的是登录短信，不保存密码，完成后收起表单', async () => {
  resetStores()
  const calls = []
  const restoreClient = stubClient({
    async sendLoginSms() {
      calls.push(['sendLoginSms', this.options.phone])
      return 'key-1'
    },
    async sendDeviceSms() {
      throw new Error('不该发新设备短信')
    },
    async login() {
      throw new Error('不该走密码登录')
    },
    async smsLogin(code, codeKey) {
      calls.push(['smsLogin', code, codeKey])
      return LOGIN_RESULT()
    },
  })
  const page = mountCodeForm()
  try {
    await button(page.tree(), '发送验证码').props.action()
    page.field('短信验证码').props.onChanged(' 123456 ')
    await button(page.tree(), '登录').props.action()
    assert.deepEqual(calls, [['sendLoginSms', '13812345678'], ['smsLogin', '123456', 'key-1']])
    assert.deepEqual(vault.credentials(), { phone: '13812345678', passwordMd5: null })
    const tree = page.tree()
    assert.ok(!titles(tree).includes('短信验证码'))
    assert.ok(titles(tree).includes('重新登录'))
    assert.match(texts(tree).join(' '), /登录成功/)
    assert.equal(button(tree, '立即刷新').props.disabled, false)
  } finally {
    page.restore()
    restoreClient()
  }
})

test('设置页：验证码登录收到新设备要求时切回密码登录，手上的验证码作废', async () => {
  resetStores()
  const restoreClient = stubClient({
    sendLoginSms: async () => 'key-1',
    async smsLogin() {
      throw new SgccError('device', '4006', '国网要求验证新设备')
    },
  })
  const page = mountCodeForm()
  try {
    await button(page.tree(), '发送验证码').props.action()
    page.field('短信验证码').props.onChanged('123456')
    await button(page.tree(), '登录').props.action()
    const tree = page.tree()
    assert.equal(loginMode(tree).props.value, 'password')
    assert.ok(titles(tree).includes('密码'))
    assert.ok(titles(tree).includes('验证并登录'))
    assert.equal(page.field('短信验证码').props.value, '')
    assert.match(texts(tree).join(' '), /填好密码/)
    assert.equal(vault.credentials(), null)
  } finally {
    page.restore()
    restoreClient()
  }
})

test('设置页：验证码登录被风控拦下时显示代码，不保存账号，提示短信不一定有用', async () => {
  resetStores()
  const restoreClient = stubClient({
    sendLoginSms: async () => 'key-1',
    async smsLogin() {
      throw new SgccError('risk', 'RK008', 'x')
    },
  })
  const page = mountCodeForm()
  try {
    await button(page.tree(), '发送验证码').props.action()
    page.field('短信验证码').props.onChanged('123456')
    await button(page.tree(), '登录').props.action()
    const all = texts(page.tree()).join(' ')
    assert.match(all, /RK008/)
    assert.match(all, /不要反复重试/)
    assert.match(all, /短信不一定能解决/)
    assert.equal(vault.credentials(), null)
    assert.ok(titles(page.tree()).includes('短信验证码'), '表单还在')
  } finally {
    page.restore()
    restoreClient()
  }
})

test('设置页：切换登录方式不能绕过发送验证码的冷却时间', async () => {
  resetStores()
  let sends = 0
  const restoreClient = stubClient({
    async sendLoginSms() {
      sends++
      return 'key-1'
    },
  })
  const page = mountCodeForm()
  try {
    await button(page.tree(), '发送验证码').props.action()
    loginMode(page.tree()).props.onChanged('password')
    loginMode(page.tree()).props.onChanged('code')
    await button(page.tree(), '发送验证码').props.action()
    assert.equal(sends, 1)
    assert.match(texts(page.tree()).join(' '), /秒后再发送/)
  } finally {
    page.restore()
    restoreClient()
  }
})

test('设置页：改了手机号，之前的验证码就作废', async () => {
  resetStores()
  const restoreClient = stubClient({ sendLoginSms: async () => 'key-1' })
  const page = mountCodeForm()
  try {
    await button(page.tree(), '发送验证码').props.action()
    page.field('短信验证码').props.onChanged('123456')
    assert.equal(button(page.tree(), '登录').props.disabled, false)
    page.field('手机号').props.onChanged('13900000000')
    assert.equal(page.field('短信验证码').props.value, '')
    assert.ok(button(page.tree(), '登录').props.disabled)
  } finally {
    page.restore()
    restoreClient()
  }
})

test('设置页：只用验证码登录过且已到期时，直接显示验证码登录的表单，不能刷新', () => {
  resetStores()
  vault.saveCredentials({ phone: '13812345678', passwordMd5: null })
  vault.saveAccounts([ACCOUNT])
  const tree = renderSettings()
  assert.match(texts(tree).join(' '), /登录已过期/)
  assert.equal(loginMode(tree).props.value, 'code')
  assert.ok(titles(tree).includes('发送验证码'))
  assert.ok(!titles(tree).includes('密码'))
  assert.ok(button(tree, '立即刷新').props.disabled)
  assert.ok(button(tree, '诊断每日数据').props.disabled)
  assert.ok(!titles(tree).includes('取消'), '已经过期，没有可以退回去的状态')
})

test('设置页：只用验证码登录过且还有效时，收起表单；重新登录的确认框不说会自动续', async () => {
  resetStores()
  vault.saveCredentials({ phone: '13812345678', passwordMd5: null })
  vault.saveSession({ token: 't', userId: 'u', province: '', expiresAt: Date.now() + 86400000 })
  vault.saveAccounts([ACCOUNT])
  const page = mountSettings()
  const original = globalThis.Dialog.confirm
  try {
    const tree = page.tree()
    assert.ok(!titles(tree).includes('发送验证码'))
    assert.doesNotMatch(texts(tree).join(' '), /登录已过期/)
    assert.equal(button(tree, '立即刷新').props.disabled, false)
    const shown = []
    globalThis.Dialog.confirm = async options => {
      shown.push(options)
      return true
    }
    await button(tree, '重新登录').props.action()
    assert.match(shown[0].message, /通常不需要重新登录/)
    assert.doesNotMatch(shown[0].message, /自动续/)
    assert.equal(loginMode(page.tree()).props.value, 'code')
  } finally {
    globalThis.Dialog.confirm = original
    page.restore()
  }
})

test('设置页：用密码登录时，重新登录的确认框仍然说明到期会自动续', async () => {
  signedInStores()
  const page = mountSettings()
  const original = globalThis.Dialog.confirm
  try {
    const shown = []
    globalThis.Dialog.confirm = async options => {
      shown.push(options)
      return false
    }
    await button(page.tree(), '重新登录').props.action()
    assert.match(shown[0].message, /到期后会自动续/)
  } finally {
    globalThis.Dialog.confirm = original
    page.restore()
  }
})

test('设置页：重新登录中取消时，已经填的验证码不留下', async () => {
  signedInStores()
  const restoreClient = stubClient({ sendLoginSms: async () => 'key-1' })
  const page = mountSettings()
  try {
    await button(page.tree(), '重新登录').props.action()
    loginMode(page.tree()).props.onChanged('code')
    await button(page.tree(), '发送验证码').props.action()
    page.field('短信验证码').props.onChanged('123456')
    button(page.tree(), '取消').props.action()
    assert.ok(!titles(page.tree()).includes('短信验证码'))
    await button(page.tree(), '重新登录').props.action()
    assert.equal(page.field('短信验证码').props.value, '')
    assert.ok(button(page.tree(), '登录').props.disabled, '要重新发码')
  } finally {
    page.restore()
    restoreClient()
  }
})
