'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { lib } = require('./support/shim.cjs')
const { buildBillView, formatKwh, formatYuan, demoSnapshot } = lib('view-model')
const { DEFAULT_SETTINGS } = lib('types')

const ACCOUNT = { id: 'a', name: '张*', consNo: '', consNoSrc: '', provinceCode: '', orgNo: '', elecType: '01' }
const base = {
  accountId: 'a',
  fetchedAt: Date.UTC(2026, 10, 4, 0, 5),
  balance: null,
  monthKwh: null,
  lastBill: null,
  yearKwh: null,
  yearYuan: null,
  yearEstimateKwh: null,
  daily: [],
}
const view = (patch = {}, settings = {}, notice = null) => buildBillView({ ...base, ...patch }, ACCOUNT, { ...DEFAULT_SETTINGS, ...settings }, notice)

test('数字格式', () => {
  assert.equal(formatYuan(88.3), '88.30')
  assert.equal(formatYuan(null), '--')
  assert.equal(formatKwh(null), '--')
  assert.equal(formatKwh(0), '0')
  assert.equal(formatKwh(12.34), '12.3')
  assert.equal(formatKwh(137.4), '137')
  assert.equal(formatKwh(2315), '2,315')
})

test('没有任何数据时全部显示占位符，不显示 0', () => {
  const v = view()
  assert.equal(v.headline.amount, '--')
  assert.equal(v.monthKwh, '--')
  assert.equal(v.yearKwh, '--')
  assert.equal(v.lastBill, null)
  assert.equal(v.latest, null)
  assert.deepEqual(v.bars, [])
  assert.equal(v.tier, null)
})

test('金额标题：预付费、后付费应交、欠费、结余', () => {
  const headline = balance => view({ balance }).headline
  assert.deepEqual(headline({ isPrepaid: true, balance: 88.35, amountDue: null, overdue: null }), { label: '账户余额', amount: '88.35', tone: 'normal' })
  assert.equal(headline({ isPrepaid: true, balance: -5, amountDue: null, overdue: null }).tone, 'danger')
  assert.deepEqual(headline({ isPrepaid: false, balance: null, amountDue: 120, overdue: null }), { label: '应交电费', amount: '120.00', tone: 'warning' })
  assert.deepEqual(headline({ isPrepaid: false, balance: 15, amountDue: 0, overdue: null }), { label: '账户余额', amount: '15.00', tone: 'normal' })
  assert.deepEqual(headline({ isPrepaid: false, balance: null, amountDue: 0, overdue: null }), { label: '应交电费', amount: '0.00', tone: 'normal' })
  assert.deepEqual(headline({ isPrepaid: false, balance: null, amountDue: 50, overdue: 50 }), { label: '历史欠费', amount: '50.00', tone: 'danger' })
})

test('柱状图：跳过缺失的日子，只取最近 N 天，最高的柱子满高', () => {
  const daily = [
    { day: '2026-10-30', kwh: 5, yuan: null },
    { day: '2026-10-31', kwh: null, yuan: null },
    { day: '2026-11-01', kwh: 20, yuan: null },
    { day: '2026-11-02', kwh: 10, yuan: null },
  ]
  const v = view({ daily }, { chartDays: 2 })
  assert.deepEqual(v.bars, [{ day: '2026-11-01', ratio: 1 }, { day: '2026-11-02', ratio: 0.5 }])
  assert.deepEqual(v.latest, { label: '11/2', kwh: '10' })
  const zero = view({ daily: [{ day: '2026-11-01', kwh: 0, yuan: null }] })
  assert.equal(zero.bars[0].ratio, 0, '全是 0 时不能除以 0')
})

test('阶梯：未设置或设置错误时不显示', () => {
  const estimate = { yearEstimateKwh: 1000 }
  assert.equal(view(estimate).tier, null)
  assert.equal(view(estimate, { tier2: 2880, tier3: 0 }).tier, null)
  assert.equal(view(estimate, { tier2: 4800, tier3: 2880 }).tier, null)
  assert.equal(view({}, { tier2: 2880, tier3: 4800 }).tier, null)
})

test('阶梯：三档的进度和文字', () => {
  const settings = { tier2: 2000, tier3: 4000 }
  const first = view({ yearEstimateKwh: 1000 }, settings).tier
  assert.deepEqual(first.segments, [0.5, 0, 0])
  assert.equal(first.level, 1)
  assert.equal(first.text, '第一档 · 距第二档 1,000 度')
  const second = view({ yearEstimateKwh: 3000 }, settings).tier
  assert.deepEqual(second.segments, [1, 0.5, 0])
  assert.equal(second.level, 2)
  const third = view({ yearEstimateKwh: 5000 }, settings).tier
  assert.deepEqual(third.segments, [1, 1, 0.5])
  assert.equal(third.level, 3)
  assert.equal(third.text, '第三档 · 已超出 1,000 度')
  assert.deepEqual(view({ yearEstimateKwh: 2000 }, settings).tier.segments, [1, 0, 0], '正好踩线还算第一档')
  assert.equal(view({ yearEstimateKwh: 2000 }, settings).tier.level, 1)
})

test('显示名称优先用自定义的', () => {
  assert.equal(view().title, '张*')
  assert.equal(view({}, { names: { a: '老家' } }).title, '老家')
})

test('更新时间按北京时间显示', () => {
  assert.equal(view().updated, '11/4 08:05')
})

test('上期账单标题', () => {
  const v = view({ lastBill: { month: '2026-09', kwh: 305, yuan: 198.25, endDay: null } })
  assert.deepEqual(v.lastBill, { label: '9月账单', yuan: '198.25' })
})

test('演示数据能正常生成', () => {
  const snapshot = demoSnapshot(Date.UTC(2026, 0, 3))
  assert.equal(snapshot.daily.length, 21)
  assert.equal(snapshot.lastBill.month, '2025-11')
})
