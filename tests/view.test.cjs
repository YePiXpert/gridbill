'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { lib } = require('./support/shim.cjs')
const { buildBillView, buildDetailView, formatKwh, formatYuan, demoSnapshot } = lib('view-model')
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
  assert.equal(v.axis, null)
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

test('阶梯：三档的进度和文字', () => {
  const settings = { tier2: 2000, tier3: 4000 }
  const first = view({ yearEstimateKwh: 1000 }, settings).tier
  assert.deepEqual(first.segments, [0.5, 0, 0])
  assert.equal(first.level, 1)
  assert.equal(first.label, '第一档')
  assert.equal(first.hint, '距第二档 1,000 度')
  const second = view({ yearEstimateKwh: 3000 }, settings).tier
  assert.deepEqual(second.segments, [1, 0.5, 0])
  assert.equal(second.level, 2)
  assert.equal(second.label, '第二档')
  assert.equal(second.hint, '距第三档 1,000 度')
  const third = view({ yearEstimateKwh: 5000 }, settings).tier
  assert.deepEqual(third.segments, [1, 1, 0.5])
  assert.equal(third.level, 3)
  assert.equal(third.label, '第三档')
  assert.equal(third.hint, '已超出 1,000 度')
  assert.deepEqual(view({ yearEstimateKwh: 2000 }, settings).tier.segments, [1, 0, 0], '正好踩线还算第一档')
  assert.equal(view({ yearEstimateKwh: 2000 }, settings).tier.level, 1)
})

/** 连续 count 天的读数，最后一天是 last。 */
const readings = (count, kwh = () => 14, last = '2026-11-03') =>
  Array.from({ length: count }, (_, i) => ({
    day: new Date(Date.parse(last) - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    kwh: kwh(i),
    yuan: null,
  }))
/** 北京时间 11 月 5 日上午，最新读数是 11/3。 */
const NOV_5 = Date.UTC(2026, 10, 5, 1, 28)
const forecast = (yearEstimateKwh, patch = {}) => view({ fetchedAt: NOV_5, yearEstimateKwh, daily: readings(14), ...patch }).tier

test('跨档预估：按日均算，并扣掉读数还没出来的那几天', () => {
  const tier = forecast(4700)
  assert.equal(tier.label, '第二档')
  assert.equal(tier.hint, '约 5 天后进第三档', '100 度 ÷ 14 度/天 ≈ 7.1 天，11/3 之后的两天已经过去了')
  assert.equal(tier.urgent, true)
  assert.equal(forecast(2800).hint, '约 4 天后进第二档', '第一档到第二档也一样')
})

test('跨档预估：马上就到时至少说 1 天，不会说 0 天或负数', () => {
  assert.equal(forecast(4799).hint, '约 1 天后进第三档')
  assert.equal(forecast(4800).hint, '约 1 天后进第三档', '正好踩线还算第二档')
})

test('跨档预估：超过 30 天不预估，只显示还差多少度', () => {
  const tier = forecast(3000)
  assert.equal(tier.hint, '距第三档 1,800 度')
  assert.equal(tier.urgent, false)
  assert.equal(forecast(4800 - 14 * 32).urgent, true, '正好 30 天还预估')
  assert.equal(forecast(4800 - 14 * 33).urgent, false, '31 天就不预估了')
})

test('跨档预估：今年到不了的不预估，阶梯 1 月 1 日重新累计', () => {
  const december = { fetchedAt: Date.UTC(2026, 11, 20, 1), daily: readings(14, () => 14, '2026-12-18') }
  assert.equal(forecast(4500, december).hint, '距第三档 300 度', '约 19 天后已经是明年')
  assert.equal(forecast(4700, december).hint, '约 5 天后进第三档', '年内能到的还预估')
  assert.equal(forecast(4790, { fetchedAt: Date.UTC(2026, 11, 31, 1), daily: readings(14, () => 14, '2026-12-29') }).urgent, false, '最后一天没有“之后”了')
})

test('跨档预估：读数太少或一直没用电时不预估', () => {
  assert.equal(forecast(4700, { daily: readings(2) }).hint, '距第三档 100 度')
  assert.equal(forecast(4700, { daily: [] }).hint, '距第三档 100 度')
  assert.equal(forecast(4700, { daily: readings(14, () => 0) }).hint, '距第三档 100 度', '不能除以 0')
  assert.equal(forecast(4700, { daily: readings(3) }).urgent, true, '3 天就够了')
})

test('跨档预估：已经到第三档就没有下一档了', () => {
  const tier = forecast(5000)
  assert.equal(tier.hint, '已超出 200 度')
  assert.equal(tier.urgent, false)
})

test('图表说明：从第一根柱子的日期开始，日均按显示的这几天算', () => {
  const daily = [...readings(6, () => 100, '2026-10-20'), ...readings(14, i => (i % 2 ? 10 : 20))]
  assert.deepEqual(view({ daily }).axis, { start: '10/21', average: '15' }, '更早的 6 天不算进日均')
  assert.deepEqual(view({ daily: readings(7) }, { chartDays: 7 }).axis, { start: '10/28', average: '14' })
  assert.equal(view({ daily: readings(14, i => 10 + i / 7) }).axis.average, '10.9', '保留一位小数')
})

test('图表说明：读数不够时，起始日期算到最左一格', () => {
  assert.equal(view({ daily: readings(4) }).axis.start, '10/21', '11/3 往前数 14 格，其中 10 格是空的')
  assert.equal(view({ daily: readings(4, () => 14, '2026-01-03') }).axis.start, '12/21', '跨年也对')
})

test('图表说明：读数少于 3 天没有日均，没有读数就没有说明', () => {
  assert.equal(view({ daily: readings(2) }).axis.average, null)
  assert.equal(view({ daily: readings(3) }).axis.average, '14')
  assert.equal(view({ daily: [{ day: '2026-11-01', kwh: null, yuan: null }] }).axis, null, '占位行不算读数')
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

const detail = (patch = {}, settings = {}) => buildDetailView({ ...base, ...patch }, ACCOUNT, { ...DEFAULT_SETTINGS, ...settings })
const bill = (month, kwh = 100, yuan = 50) => ({ month, kwh, yuan, endDay: null })

test('详情页：最多 30 天读数，日均和最高只算这 30 天', () => {
  const v = detail({ daily: readings(31, i => (i === 0 ? 999 : 10)) })
  assert.equal(v.daily.length, 30)
  assert.equal(v.daily[0].day, '2026-10-05')
  assert.equal(v.daily[29].day, '2026-11-03')
  assert.deepEqual(v.dailyAverage, { kwh: 10, text: '10 度' }, '第一天的 999 已经不在 30 天里')
  assert.deepEqual(v.dailyPeak, { label: '10/5', kwh: '10 度' })
  assert.deepEqual(Object.keys(v.daily[0]), ['day', 'kwh'])
})

test('详情页：最高取真正最高的一天，一样高时取最早的', () => {
  assert.deepEqual(detail({ daily: readings(5, i => [3, 9, 4, 9, 2][i]) }).dailyPeak, { label: '10/31', kwh: '9 度' })
})

test('详情页：旧快照里的占位行不算读数', () => {
  const daily = [...readings(3), { day: '2026-11-04', kwh: null, yuan: null }]
  const v = detail({ daily })
  assert.equal(v.daily.length, 3)
  assert.equal(v.dailyAverage.text, '14 度')
})

test('详情页：读数少于 3 天没有日均，但有最高；没有读数时都没有', () => {
  const two = detail({ daily: readings(2) })
  assert.equal(two.dailyAverage, null)
  assert.ok(two.dailyPeak)
  const none = detail()
  assert.deepEqual(none.daily, [])
  assert.equal(none.dailyAverage, null)
  assert.equal(none.dailyPeak, null)
})

test('详情页：账单列表最新的在前，图表时间升序，跨年写明年份', () => {
  const v = detail({ bills: [bill('2025-12', 305, 198.25), bill('2026-01', 280, 150), bill('2026-10', 1234.4, 1000)] })
  assert.deepEqual(v.monthRows, [
    { label: '10月', value: '1,234 度 · 1000.00 元' },
    { label: '1月', value: '280 度 · 150.00 元' },
    { label: '2025年12月', value: '305 度 · 198.25 元' },
  ])
  assert.deepEqual(v.months, [{ label: '12月', kwh: 305 }, { label: '1月', kwh: 280 }, { label: '10月', kwh: 1234.4 }])
})

test('详情页：缺电量或电费的账单显示 --，图表跳过没有电量的月份', () => {
  const v = detail({ bills: [bill('2026-08', null, 50), bill('2026-09', 100, null), bill('2026-10', null, null)] })
  assert.deepEqual(v.monthRows.map(row => row.value), ['-- · --', '100 度 · --', '-- · 50.00 元'])
  assert.deepEqual(v.months, [{ label: '9月', kwh: 100 }], '不能画成 0')
})

test('详情页：旧快照没有账单列表时先显示上期账单，都没有时是空的', () => {
  const old = detail({ lastBill: bill('2026-10', 300, 247) })
  assert.deepEqual(old.monthRows, [{ label: '10月', value: '300 度 · 247.00 元' }])
  assert.deepEqual(old.months, [{ label: '10月', kwh: 300 }])
  assert.deepEqual(detail({ bills: [], lastBill: bill('2026-10') }).monthRows.length, 1, '空列表也一样')
  assert.deepEqual(detail().monthRows, [])
  assert.deepEqual(detail().months, [])
})

test('详情页：今年已出账，缺一项显示 --，都缺时不显示', () => {
  assert.equal(detail({ yearKwh: 4650, yearYuan: 2345.6 }).yearSettled, '4,650 度 · 2345.60 元')
  assert.equal(detail({ yearKwh: 4650 }).yearSettled, '4,650 度 · --')
  assert.equal(detail().yearSettled, null)
})

test('详情页：账单只显示最近 12 个月，多存的不显示', () => {
  const bills = Array.from({ length: 24 }, (_, i) => bill(new Date(Date.UTC(2024, 10 + i, 1)).toISOString().slice(0, 7)))
  const v = detail({ bills })
  assert.equal(v.months.length, 12)
  assert.equal(v.monthRows.length, 12)
  assert.equal(v.monthRows[0].label, '10月')
  assert.equal(v.monthRows[11].label, '2025年11月')
})

const outlookRow = (v, label) => v.outlook.find(row => row.label === label)?.value
/** 北京时间 11 月 5 日，最新读数 11/3，日均 14 度，今年累计 4700 度。 */
const november = { fetchedAt: NOV_5, monthKwh: 40, yearEstimateKwh: 4700, daily: readings(14) }

test('本月预计：已用的加上剩下日子的日均，跨档的部分按第三档算', () => {
  // 11/4–11/30 共 27 天 × 14 度 = 378 度，本月约 418 度。月底累计 5078 度：其中 140 度在第二档，278 度在第三档。
  assert.equal(outlookRow(detail(november), '本月预计'), '约 420 度 · 约 290 元')
  assert.equal(outlookRow(detail({ ...november, yearEstimateKwh: 3000 }), '本月预计'), '约 420 度 · 约 230 元', '全在第二档')
})

test('本月预计：最新读数还在上个月时，整个月都算剩下的日子', () => {
  const v = detail({ fetchedAt: Date.UTC(2026, 10, 2, 1), monthKwh: null, yearEstimateKwh: 1000, daily: readings(14, () => 14, '2026-10-31') })
  assert.equal(outlookRow(v, '本月预计'), '约 420 度 · 约 210 元', '30 天 × 14 度，全在第一档')
  const lagging = detail({ fetchedAt: Date.UTC(2026, 10, 2, 1), monthKwh: null, yearEstimateKwh: 1000, daily: readings(14, () => 14, '2026-10-28') })
  assert.match(outlookRow(lagging, '本月预计'), /^约 420 度/, '上个月没出数据的那几天不算本月')
})

test('本月预计：月底读数已经出来时，就是实际用电', () => {
  const v = detail({ fetchedAt: Date.UTC(2026, 11, 1, 1), monthKwh: 400, yearEstimateKwh: 4000, daily: readings(14, () => 14, '2026-12-01') })
  assert.match(outlookRow(v, '本月预计'), /^约 820 度/, '12/1 的读数之后还有 30 天')
  const lastDay = detail({ fetchedAt: Date.UTC(2026, 10, 30, 15), monthKwh: 400, yearEstimateKwh: 4000, daily: readings(14, () => 14, '2026-11-30') })
  assert.match(outlookRow(lastDay, '本月预计'), /^约 400 度/)
})

test('全年预计：没有去年账单时后面的月份也按日均算', () => {
  // 4700 + 本月剩下 378 + 12 月 31 × 14 = 434，共 5512 度，超出第三档起点 712 度。
  const v = detail(november)
  assert.equal(outlookRow(v, '全年预计'), '约 5,500 度 · 约 3,000 元')
  assert.equal(v.outlookNote, '约 710 度落在第三档，比按第二档多花约 180 元')
})

test('全年预计：后面的月份优先用去年同月的账单，因为用电随季节变化', () => {
  const v = detail({ ...november, bills: [bill('2025-12', 600)] })
  assert.equal(outlookRow(v, '全年预计'), '约 5,700 度 · 约 3,100 元', '4700 + 378 + 600')
  assert.equal(v.outlookNote, '约 880 度落在第三档，比按第二档多花约 220 元')
  assert.match(outlookRow(detail({ ...november, bills: [bill('2025-12', null)] }), '全年预计'), /^约 5,500 度/, '去年同月没有电量就退回日均')
  assert.match(outlookRow(detail({ ...november, bills: [bill('2024-12', 600)] }), '全年预计'), /^约 5,500 度/, '只认去年的，不能拿更早的')
})

test('全年预计：已出账的部分用真实金额，只有后面的部分按单价估算', () => {
  const v = detail({ ...november, yearKwh: 4000, yearYuan: 1900 })
  assert.equal(outlookRow(v, '全年预计'), '约 5,500 度 · 约 2,900 元', '1900 + 800×0.5383 + 712×0.7883')
  assert.match(outlookRow(detail({ ...november, yearKwh: 4000 }), '全年预计'), /约 3,000 元$/, '金额缺失时全部按单价算')
  assert.match(outlookRow(detail({ ...november, yearKwh: 9000, yearYuan: 1 }), '全年预计'), /约 3,000 元$/, '已出账比预计还多时数据有问题，不用它')
})

test('全年预计：预计到不了第三档时说第二档，都在第一档时也说清楚', () => {
  assert.equal(detail({ ...november, yearEstimateKwh: 3000 }).outlookNote, '约 930 度落在第二档，比按第一档多花约 47 元')
  assert.equal(detail({ ...november, yearEstimateKwh: 1000 }).outlookNote, '预计全年都在第一档')
})

test('预计：十二月没有后面的月份，一月不把去年的日子算进今年', () => {
  const december = detail({ fetchedAt: Date.UTC(2026, 11, 20, 1), monthKwh: 200, yearEstimateKwh: 4000, daily: readings(14, () => 14, '2026-12-18') })
  assert.match(outlookRow(december, '本月预计'), /^约 380 度/, '200 + 13 × 14')
  assert.match(outlookRow(december, '全年预计'), /^约 4,200 度/, '4000 + 13 × 14')
  // 累计取 30 度：结果 5140 度显示成 5,100；要是多算了去年那两天（28 度）就是 5168 度，会显示成 5,200。
  const january = latest => detail({ fetchedAt: Date.UTC(2027, 0, 2, 1), monthKwh: null, yearEstimateKwh: 30, daily: readings(14, () => 14, latest) })
  assert.match(outlookRow(january('2026-12-31'), '全年预计'), /^约 5,100 度/, '30 + 365 × 14')
  assert.match(outlookRow(january('2026-12-29'), '全年预计'), /^约 5,100 度/, '去年最后两天没出数据，也不算今年的')
  assert.match(outlookRow(january('2026-12-29'), '本月预计'), /^约 430 度/)
})

test('预计：读数太少不预计，没有累计时只有本月电量，档位不对时不算钱', () => {
  const few = detail({ ...november, daily: readings(2) })
  assert.equal(outlookRow(few, '本月预计'), undefined)
  assert.equal(outlookRow(few, '全年预计'), undefined)
  assert.equal(few.outlookNote, null)

  const noYear = detail({ ...november, yearEstimateKwh: null })
  assert.equal(outlookRow(noYear, '本月预计'), '约 420 度')
  assert.equal(outlookRow(noYear, '全年预计'), undefined)
  assert.equal(noYear.outlookNote, null)

  const badTiers = detail(november, { tier2: 0, tier3: 0 })
  assert.equal(outlookRow(badTiers, '本月预计'), '约 420 度')
  assert.equal(outlookRow(badTiers, '全年预计'), '约 5,500 度')
  assert.equal(badTiers.outlookNote, null)
})

test('预计：一直没用电时也不出错', () => {
  const v = detail({ ...november, monthKwh: 0, yearEstimateKwh: 0, daily: readings(14, () => 0) })
  assert.equal(outlookRow(v, '本月预计'), '约 0 度 · 约 0 元')
  assert.equal(v.outlookNote, '预计全年都在第一档')
})

test('和上月比：优先用上月账单换算成日均', () => {
  const compare = kwh => outlookRow(detail({ ...november, bills: [bill('2026-10', kwh)] }), '本月日均')
  assert.equal(compare(310), '14 度 · 比上月高 40%', '310 度 ÷ 31 天 = 10 度/天')
  assert.equal(compare(620), '14 度 · 比上月低 30%')
  assert.equal(compare(434), '14 度 · 和上月差不多')
  assert.equal(compare(0), undefined, '上月没用电不能除以 0')
})

test('和上月比：天数按上个月实际算，一月和上一年的十二月比', () => {
  const march = detail({ fetchedAt: Date.UTC(2026, 2, 5, 1), daily: readings(4, () => 14, '2026-03-04'), bills: [bill('2026-02', 280)] })
  assert.equal(outlookRow(march, '本月日均'), '14 度 · 比上月高 40%', '280 度 ÷ 28 天')
  const january = detail({ fetchedAt: Date.UTC(2027, 0, 5, 1), daily: readings(4, () => 14, '2027-01-04'), bills: [bill('2026-12', 310)] })
  assert.equal(outlookRow(january, '本月日均'), '14 度 · 比上月高 40%')
})

test('和上月比：上月还没出账时用它的每日读数，太少就不比', () => {
  const daily = readings(14, i => (i < 11 ? 10 : 20))
  assert.equal(outlookRow(detail({ ...november, daily }), '本月日均'), '20 度 · 比上月高 100%', '10 月 11 天，11 月 3 天')
  assert.equal(outlookRow(detail({ ...november, daily: readings(9) }), '本月日均'), undefined, '10 月只有 6 天')
  assert.ok(outlookRow(detail({ ...november, daily: readings(10) }), '本月日均'), '10 月有 7 天就够了')
})

test('和上月比：本月读数少于 3 天不比', () => {
  const v = detail({ fetchedAt: Date.UTC(2026, 10, 3, 1), daily: readings(14, () => 14, '2026-11-02'), bills: [bill('2026-10', 310)] })
  assert.equal(outlookRow(v, '本月日均'), undefined)
})

test('和去年比：最新账单和去年同月的电量比，看的是度数不是金额', () => {
  const compare = kwh => outlookRow(detail({ bills: [bill('2025-10', kwh, 999), bill('2026-10', 300, 1)] }), '10月用电')
  assert.equal(compare(250), '300 度 · 比去年同月多 20%')
  assert.equal(compare(400), '300 度 · 比去年同月少 25%')
  assert.equal(compare(300), '300 度 · 和去年同月差不多')
  assert.equal(compare(null), undefined)
  assert.equal(compare(0), undefined)
  assert.equal(outlookRow(detail({ bills: [bill('2026-10', 300)] }), '10月用电'), undefined, '没有去年同月')
  assert.equal(outlookRow(detail({ bills: [bill('2025-10', 250), bill('2026-10', null)] }), '10月用电'), undefined, '今年这个月没有电量')
})

test('和去年比：用到的是多存的账单，超出 12 个月的显示范围也能比', () => {
  const bills = Array.from({ length: 13 }, (_, i) => bill(new Date(Date.UTC(2025, 9 + i, 1)).toISOString().slice(0, 7), i === 0 ? 250 : 300))
  const v = detail({ bills })
  assert.equal(v.monthRows.length, 12)
  assert.equal(outlookRow(v, '10月用电'), '300 度 · 比去年同月多 20%')
})

test('预计和对比：什么数据都没有时是空的', () => {
  const v = detail()
  assert.deepEqual(v.outlook, [])
  assert.equal(v.outlookNote, null)
})

test('预计和对比：顺序固定', () => {
  const v = detail({ ...november, bills: [bill('2025-10', 250), bill('2026-10', 300)] })
  assert.deepEqual(v.outlook.map(row => row.label), ['本月预计', '全年预计', '本月日均', '10月用电'])
})

test('详情页：小组件那部分内容和小组件算出来的一样', () => {
  const patch = { yearEstimateKwh: 4700, monthKwh: 42, daily: readings(14), fetchedAt: NOV_5 }
  assert.deepEqual(detail(patch).bill, view(patch))
})

test('演示数据能正常生成', () => {
  const snapshot = demoSnapshot(Date.UTC(2026, 0, 3))
  assert.equal(snapshot.daily.length, 21)
  assert.equal(snapshot.lastBill.month, '2025-11')
})
