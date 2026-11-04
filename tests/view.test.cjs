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
  assert.equal(v.monthCost, null)
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

test('默认值是北京一户一表、不满 1 千伏的标准', () => {
  const { tier2, tier3, price1, price2, price3 } = DEFAULT_SETTINGS
  assert.deepEqual([tier2, tier3], [240 * 12, 400 * 12])
  assert.deepEqual([price1, price2, price3], [0.4883, 0.5383, 0.7883])
})

test('阶梯：设置错误或没有累计数据时不显示', () => {
  const estimate = { yearEstimateKwh: 1000 }
  assert.ok(view(estimate).tier, '默认设置下要显示')
  assert.equal(view(estimate, { tier2: 0, tier3: 0 }).tier, null)
  assert.equal(view(estimate, { tier2: 2880, tier3: 0 }).tier, null)
  assert.equal(view(estimate, { tier2: 4800, tier3: 2880 }).tier, null)
  assert.equal(view().tier, null)
})

test('阶梯：三档的进度、单价和文字', () => {
  const settings = { tier2: 2000, tier3: 4000 }
  const first = view({ yearEstimateKwh: 1000 }, settings).tier
  assert.deepEqual(first.segments, [0.5, 0, 0])
  assert.equal(first.level, 1)
  assert.equal(first.text, '第一档 0.4883 元/度 · 距第二档 1,000 度')
  const second = view({ yearEstimateKwh: 3000 }, settings).tier
  assert.deepEqual(second.segments, [1, 0.5, 0])
  assert.equal(second.level, 2)
  assert.equal(second.text, '第二档 0.5383 元/度 · 距第三档 1,000 度')
  const third = view({ yearEstimateKwh: 5000 }, settings).tier
  assert.deepEqual(third.segments, [1, 1, 0.5])
  assert.equal(third.level, 3)
  assert.equal(third.text, '第三档 0.7883 元/度 · 已超出 1,000 度')
  assert.deepEqual(view({ yearEstimateKwh: 2000 }, settings).tier.segments, [1, 0, 0], '正好踩线还算第一档')
  assert.equal(view({ yearEstimateKwh: 2000 }, settings).tier.level, 1)
})

test('本月电费：按本月这段用电落在哪几档分别计价', () => {
  const cost = (monthKwh, yearEstimateKwh, settings) => view({ monthKwh, yearEstimateKwh }, settings).monthCost
  assert.equal(cost(100, 1000), '48.83', '全在第一档')
  assert.equal(cost(100, 4000), '53.83', '全在第二档')
  assert.equal(cost(100, 6000), '78.83', '全在第三档')
  assert.equal(cost(100, 2900), '49.83', '跨第一、二档：80×0.4883 + 20×0.5383')
  assert.equal(cost(100, 4850), '66.33', '跨第二、三档：50×0.5383 + 50×0.7883')
  assert.equal(cost(5000, 5000), '2597.50', '三档都跨到')
  assert.equal(cost(0, 1000), '0.00')
  assert.equal(cost(100, 4000, { price2: 0.6 }), '60.00', '单价可以改')
})

test('本月电费：累计比本月还少时不会算少，缺数据时不显示', () => {
  const cost = (monthKwh, yearEstimateKwh, settings) => view({ monthKwh, yearEstimateKwh }, settings).monthCost
  assert.equal(cost(100, 40), '48.83')
  assert.equal(cost(null, 1000), null)
  assert.equal(cost(100, null), null)
  assert.equal(cost(100, 1000, { tier2: 0, tier3: 0 }), null, '档位设置不对时算不出来')
})

test('显示名称优先用自定义的', () => {
  assert.equal(view().title, '张*')
  assert.equal(view({}, { names: { a: '老家' } }).title, '老家')
})

test('之前保存的加密户名不显示，自定义名称不受影响', () => {
  const opaque = { ...ACCOUNT, name: '99:0123456789abcdef0123456789abcdef:02:osg-uc:2601010000:001' }
  assert.equal(buildBillView(base, opaque, DEFAULT_SETTINGS, null).title, '用电户号')
  assert.equal(buildBillView(base, opaque, { ...DEFAULT_SETTINGS, names: { a: '老家' } }, null).title, '老家')
})

test('图表格数跟随设置，和实际读数多少无关', () => {
  const daily = [{ day: '2026-11-01', kwh: 5, yuan: null }]
  assert.equal(view({ daily }, { chartDays: 21 }).chartSlots, 21)
  assert.equal(view({ daily }).bars.length, 1)
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
