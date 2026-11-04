'use strict'
// UI 冒烟测试：确认组件在各种状态下都能渲染、不抛错、显示对的内容。
// 用的是假组件，不能代替在手机上看真实效果。
const test = require('node:test')
const assert = require('node:assert/strict')
const { fake, expand, texts, findAll } = require('./support/fake-ui.cjs')
const { resetStores } = require('./support/shim.cjs')

const { WidgetRoot, amountFontSize } = require('../.build/GridBill/ui/widget-views')
const { SettingsPage, loadInitialState } = require('../.build/GridBill/ui/settings')
const { buildBillView, demoSnapshot } = require('../.build/GridBill/lib/view-model')
const { DEFAULT_SETTINGS } = require('../.build/GridBill/lib/types')
const { vault } = require('../.build/GridBill/lib/vault')

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
        assert.ok(bar.props.frame.maxHeight >= 2 && bar.props.frame.maxHeight <= 44)
      }
    }
  })

  test(`${family}：阶梯未设置时不画，设置后画三段`, () => {
    assert.equal(findAll(render({ state: 'ok', view: demoView(), nextRefresh: next }, family, size), 'ProgressView').length, 0)
    const segments = findAll(render({ state: 'ok', view: demoView({ tier2: 2880, tier3: 4800 }), nextRefresh: next }, family, size), 'ProgressView')
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
  assert.equal(all.filter(text => text === '元').length, 1, '只有上期账单带“元”')
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

test('设置页：被闸门拦下时提示并要求重新登录', () => {
  resetStores()
  vault.saveCredentials({ phone: '13812345678', passwordMd5: 'x' })
  vault.saveAccounts([ACCOUNT])
  vault.saveGate({ block: { kind: 'credentials', message: '密码错误', at: 1 }, lastAutoLoginAt: 0 })
  const tree = renderSettings()
  assert.match(texts(tree).join(' '), /已暂停自动更新/)
  assert.ok(titles(tree).includes('密码'))
  assert.ok(button(tree, '立即刷新').props.disabled)
})
