/** 把数据变成小组件要显示的文字和比例。纯函数，方便测试。 */
import { chinaTime } from './protocol/client'
import { isOpaque } from './protocol/parse'
import type { Account, Balance, MonthlyBill, Settings, Snapshot } from './types'

export type Tone = 'normal' | 'warning' | 'danger'

export type BillView = {
  title: string
  headline: { label: string; amount: string; tone: Tone }
  monthKwh: string
  /** 本月已用电量按阶梯单价估算的电费，算不出来时是 null */
  monthCost: string | null
  lastBill: { label: string; yuan: string } | null
  yearKwh: string
  /** 真实读数，时间升序；缺失的日子不算进来，不当成 0 */
  bars: Array<{ day: string; ratio: number }>
  /** 图表固定的格数。读数不够时前面留空，柱子不会被撑粗 */
  chartSlots: number
  /** 图表下方的说明：最左一格的日期和日均。没有读数时是 null，读数太少时没有日均 */
  axis: { start: string; average: string | null } | null
  latest: { label: string; kwh: string } | null
  /** hint 是到下一档的提示；urgent 表示快到了，要醒目一点 */
  tier: { segments: [number, number, number]; level: 1 | 2 | 3; label: string; hint: string; urgent: boolean } | null
  updated: string
  notice: string | null
}

/** 详情页要显示的内容。图表要真实数字，列表要格式化好的文字。 */
export type DetailView = {
  bill: BillView
  /** 最近 30 个有读数的日子，时间升序 */
  daily: Array<{ day: string; kwh: number }>
  dailyAverage: { kwh: number; text: string } | null
  dailyPeak: { label: string; kwh: string } | null
  /** 有电量的账单，时间升序，画图用 */
  months: Array<{ label: string; kwh: number }>
  /** 全部账单，最新的在前，列表用 */
  monthRows: Array<{ label: string; value: string }>
  /** 今年已出账的电量和电费 */
  yearSettled: string | null
  /** 预计和对比，算不出来的项不出现，都算不出来时是空数组 */
  outlook: Array<{ label: string; value: string }>
  /** 全年预计落在哪一档、因此多花多少 */
  outlookNote: string | null
}

export const PLACEHOLDER = '--'

const DAY_MS = 86_400_000
const DETAIL_DAYS = 30
/** 详情页的账单只显示这么多个月，多存的是给同比和全年预计用的。 */
const DETAIL_BILL_MONTHS = 12
/** 读数太少时平均值没有参考价值。 */
const MIN_DAYS_FOR_AVERAGE = 3
/** 上个月还没出账时，用它的每日读数当对比基准，太少了就不比。 */
const MIN_DAYS_TO_COMPARE = 7
/** 用电量随季节变化，更远的预估不可靠，不如直接显示还差多少度。 */
const FORECAST_WITHIN_DAYS = 30

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS)
const addDays = (isoDay: string, days: number) => new Date(Date.parse(isoDay) + days * DAY_MS).toISOString().slice(0, 10)

export function formatYuan(value: number | null): string {
  return value === null ? PLACEHOLDER : value.toFixed(2)
}

/** 137 → 137；12.34 → 12.3；2315 → 2,315；缺失 → -- */
export function formatKwh(value: number | null): string {
  if (value === null) return PLACEHOLDER
  if (Math.abs(value) >= 100) return Math.round(value).toLocaleString('en-US')
  return String(Math.round(value * 10) / 10)
}

function headline(balance: Balance | null): BillView['headline'] {
  if (!balance) return { label: '账户余额', amount: PLACEHOLDER, tone: 'normal' }
  if (balance.overdue !== null) return { label: '历史欠费', amount: formatYuan(balance.overdue), tone: 'danger' }
  if (balance.amountDue !== null && balance.amountDue > 0) return { label: '应交电费', amount: formatYuan(balance.amountDue), tone: 'warning' }
  if (balance.balance !== null) return { label: '账户余额', amount: formatYuan(balance.balance), tone: balance.balance < 0 ? 'danger' : 'normal' }
  if (balance.amountDue !== null) return { label: '应交电费', amount: formatYuan(balance.amountDue), tone: 'normal' }
  return { label: '账户余额', amount: PLACEHOLDER, tone: 'normal' }
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const hasValidTiers = ({ tier2, tier3 }: Settings) => tier2 > 0 && tier3 > tier2

type Pace = { kwhPerDay: number; latestDay: string; today: string }

/**
 * 按近期日均估算还有几天到下一档。
 * 读数有延迟：最新读数之后到今天这几天已经在用电了，要扣掉。
 * 阶梯每年 1 月 1 日重新累计，今年到不了的就不预估。
 */
function daysToNextTier(remaining: number, pace: Pace | null): number | null {
  if (!pace || pace.kwhPerDay <= 0) return null
  const days = Math.max(1, Math.round(remaining / pace.kwhPerDay - daysBetween(pace.latestDay, pace.today)))
  const leftThisYear = daysBetween(pace.today, `${pace.today.slice(0, 4)}-12-31`)
  return days <= Math.min(FORECAST_WITHIN_DAYS, leftThisYear) ? days : null
}

function nextTierHint(remaining: number, nextLabel: string, pace: Pace | null): { hint: string; urgent: boolean } {
  const days = daysToNextTier(remaining, pace)
  return days === null ? { hint: `距${nextLabel} ${formatKwh(remaining)} 度`, urgent: false } : { hint: `约 ${days} 天后进${nextLabel}`, urgent: true }
}

function tier(used: number | null, settings: Settings, pace: Pace | null): BillView['tier'] {
  if (used === null || !hasValidTiers(settings)) return null
  const { tier2, tier3 } = settings
  const segments: [number, number, number] = [
    clamp01(used / tier2),
    clamp01((used - tier2) / (tier3 - tier2)),
    clamp01((used - tier3) / (tier3 - tier2)),
  ]
  if (used <= tier2) return { segments, level: 1, label: '第一档', ...nextTierHint(tier2 - used, '第二档', pace) }
  if (used <= tier3) return { segments, level: 2, label: '第二档', ...nextTierHint(tier3 - used, '第三档', pace) }
  return { segments, level: 3, label: '第三档', hint: `已超出 ${formatKwh(used - tier3)} 度`, urgent: false }
}

/** 今年累计从 from 走到 to 这一段电费：落在哪几档，就按哪几档分别计价。 */
function segmentCost(from: number, to: number, { tier2, tier3, price1, price2, price3 }: Settings): number {
  const within = (low: number, high: number) => Math.max(0, Math.min(to, high) - Math.max(from, low))
  return within(0, tier2) * price1 + within(tier2, tier3) * price2 + within(tier3, Infinity) * price3
}

/** 本月用电是今年累计的最后一段。 */
function monthCost(monthKwh: number | null, yearKwh: number, settings: Settings): string | null {
  if (monthKwh === null) return null
  const to = Math.max(yearKwh, monthKwh)
  return formatYuan(segmentCost(to - monthKwh, to, settings))
}

const shortDay = (isoDay: string) => `${Number(isoDay.slice(5, 7))}/${Number(isoDay.slice(8, 10))}`

/** 以前登录保存的户号可能还是加密串，显示时再挡一次。 */
export function accountDisplayName(account: Account): string {
  return isOpaque(account.name) ? '用电户号' : account.name
}

/** 旧版本存下的快照里还有占位行，这里统一去掉。 */
const realReadings = (snapshot: Snapshot) => snapshot.daily.filter((day): day is { day: string; kwh: number; yuan: number | null } => day.kwh !== null)

const sumKwh = (days: Array<{ kwh: number }>) => days.reduce((total, day) => total + day.kwh, 0)

export function buildBillView(snapshot: Snapshot, account: Account, settings: Settings, notice: string | null): BillView {
  const recent = realReadings(snapshot).slice(-settings.chartDays)
  const max = Math.max(0, ...recent.map(day => day.kwh))
  const last = recent[recent.length - 1]
  const updated = chinaTime(snapshot.fetchedAt)
  const average = recent.length >= MIN_DAYS_FOR_AVERAGE ? sumKwh(recent) / recent.length : null
  const pace = average === null ? null : { kwhPerDay: average, latestDay: last.day, today: updated.isoDay }
  const tierView = tier(snapshot.yearEstimateKwh, settings, pace)
  return {
    title: settings.names[account.id] || accountDisplayName(account),
    headline: headline(snapshot.balance),
    monthKwh: formatKwh(snapshot.monthKwh),
    // 有档位信息时 yearEstimateKwh 一定有值。
    monthCost: tierView ? monthCost(snapshot.monthKwh, snapshot.yearEstimateKwh as number, settings) : null,
    lastBill: snapshot.lastBill
      ? { label: `${Number(snapshot.lastBill.month.slice(5, 7))}月账单`, yuan: formatYuan(snapshot.lastBill.yuan) }
      : null,
    yearKwh: formatKwh(snapshot.yearEstimateKwh ?? snapshot.yearKwh),
    bars: recent.map(day => ({ day: day.day, ratio: max > 0 ? day.kwh / max : 0 })),
    chartSlots: settings.chartDays,
    // 读数不够时前面是空格子，起始日期要算到最左一格，否则会让人以为图表只覆盖这几天。
    axis: last ? { start: shortDay(addDays(recent[0].day, recent.length - settings.chartDays)), average: average === null ? null : formatKwh(average) } : null,
    latest: last ? { label: shortDay(last.day), kwh: formatKwh(last.kwh) } : null,
    tier: tierView,
    updated: `${updated.month}/${updated.day} ${updated.hour}:${updated.minute}`,
    notice,
  }
}

const monthNumber = (month: string) => Number(month.slice(5, 7))

function monthRowValue({ kwh, yuan }: MonthlyBill): string {
  return `${kwh === null ? PLACEHOLDER : `${formatKwh(kwh)} 度`} · ${yuan === null ? PLACEHOLDER : `${formatYuan(yuan)} 元`}`
}

const pad2 = (value: number) => String(value).padStart(2, '0')
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** 估算的数字不要显示得太精确：5504 → 5,500，419 → 420，85.3 → 85。 */
function rough(value: number): string {
  const step = value >= 1000 ? 100 : value >= 100 ? 10 : 1
  return (Math.round(value / step) * step).toLocaleString('en-US')
}

function changeText(value: number, baseline: number, against: string, more: string, less: string): string {
  const percent = Math.round(((value - baseline) / baseline) * 100)
  return percent === 0 ? `和${against}差不多` : `比${against}${percent > 0 ? more : less} ${Math.abs(percent)}%`
}

function yearTierNote(total: number, { tier2, tier3, price1, price2, price3 }: Settings): string {
  if (total > tier3) return `约 ${rough(total - tier3)} 度落在第三档，比按第二档多花约 ${rough((total - tier3) * (price3 - price2))} 元`
  if (total > tier2) return `约 ${rough(total - tier2)} 度落在第二档，比按第一档多花约 ${rough((total - tier2) * (price2 - price1))} 元`
  return '预计全年都在第一档'
}

/**
 * 预计和对比，只用已保存的数据。
 * 本月剩下的日子按最近的日均估算；后面的月份优先用去年同月的账单，因为用电随季节变化，日均估不准。
 * 最新读数之后已经过去的日子也在用电，都算进“剩下的日子”。
 */
function buildOutlook(snapshot: Snapshot, settings: Settings, bills: MonthlyBill[]): Pick<DetailView, 'outlook' | 'outlookNote'> {
  const outlook: DetailView['outlook'] = []
  let outlookNote: string | null = null
  const today = chinaTime(snapshot.fetchedAt)
  const monthKey = today.isoDay.slice(0, 7)
  const monthLast = `${monthKey}-${pad2(daysInMonth(today.year, today.month))}`
  const previousMonthLast = addDays(`${monthKey}-01`, -1)
  const billKwh = (month: string) => bills.find(bill => bill.month === month)?.kwh ?? null
  const allReadings = realReadings(snapshot)
  const recent = allReadings.slice(-DETAIL_DAYS)

  if (recent.length >= MIN_DAYS_FOR_AVERAGE) {
    const perDay = sumKwh(recent) / recent.length
    const latest = recent[recent.length - 1].day
    const counted = (floor: string) => daysBetween(latest > floor ? latest : floor, monthLast)
    const monthForecast = (snapshot.monthKwh ?? 0) + perDay * counted(previousMonthLast)
    const used = snapshot.yearEstimateKwh
    const canPrice = used !== null && hasValidTiers(settings)
    // 最新读数还在去年时，去年那几天不算今年的累计。
    const yearAtMonthEnd = used === null ? null : Math.max(used + perDay * counted(`${today.year - 1}-12-31`), monthForecast)
    const monthYuan = canPrice && yearAtMonthEnd !== null ? ` · 约 ${rough(segmentCost(yearAtMonthEnd - monthForecast, yearAtMonthEnd, settings))} 元` : ''
    outlook.push({ label: '本月预计', value: `约 ${rough(monthForecast)} 度${monthYuan}` })

    if (yearAtMonthEnd !== null) {
      let total = yearAtMonthEnd
      for (let month = today.month + 1; month <= 12; month++) {
        total += billKwh(`${today.year - 1}-${pad2(month)}`) ?? perDay * daysInMonth(today.year, month)
      }
      // 已出账的部分用真实金额，只有后面的部分按单价估算。
      const { yearKwh, yearYuan } = snapshot
      const yearCost = yearKwh !== null && yearYuan !== null && total >= yearKwh ? yearYuan + segmentCost(yearKwh, total, settings) : segmentCost(0, total, settings)
      outlook.push({ label: '全年预计', value: `约 ${rough(total)} 度${canPrice ? ` · 约 ${rough(yearCost)} 元` : ''}` })
      if (canPrice) outlookNote = yearTierNote(total, settings)
    }
  }

  const thisMonth = allReadings.filter(day => day.day.startsWith(monthKey))
  if (thisMonth.length >= MIN_DAYS_FOR_AVERAGE) {
    const previousKey = previousMonthLast.slice(0, 7)
    const previousBill = billKwh(previousKey)
    const previousReadings = allReadings.filter(day => day.day.startsWith(previousKey))
    const baseline =
      previousBill !== null
        ? previousBill / Number(previousMonthLast.slice(8, 10))
        : previousReadings.length >= MIN_DAYS_TO_COMPARE
          ? sumKwh(previousReadings) / previousReadings.length
          : 0
    if (baseline > 0) {
      const perDay = sumKwh(thisMonth) / thisMonth.length
      outlook.push({ label: '本月日均', value: `${formatKwh(perDay)} 度 · ${changeText(perDay, baseline, '上月', '高', '低')}` })
    }
  }

  const latestBill = bills[bills.length - 1]
  if (latestBill?.kwh) {
    const sameMonthLastYear = billKwh(`${Number(latestBill.month.slice(0, 4)) - 1}${latestBill.month.slice(4)}`)
    if (sameMonthLastYear) {
      outlook.push({ label: `${monthNumber(latestBill.month)}月用电`, value: `${formatKwh(latestBill.kwh)} 度 · ${changeText(latestBill.kwh, sameMonthLastYear, '去年同月', '多', '少')}` })
    }
  }
  return { outlook, outlookNote }
}

export function buildDetailView(snapshot: Snapshot, account: Account, settings: Settings): DetailView {
  const readings = realReadings(snapshot).slice(-DETAIL_DAYS)
  const peak = readings.length ? readings.reduce((highest, day) => (day.kwh > highest.kwh ? day : highest)) : null
  const average = readings.length >= MIN_DAYS_FOR_AVERAGE ? sumKwh(readings) / readings.length : null
  // 旧版本存下的快照只有上期账单，下次刷新之前先显示这一条。
  const allBills = snapshot.bills?.length ? snapshot.bills : snapshot.lastBill ? [snapshot.lastBill] : []
  const bills = allBills.slice(-DETAIL_BILL_MONTHS)
  const latestYear = bills.length ? bills[bills.length - 1].month.slice(0, 4) : ''
  return {
    ...buildOutlook(snapshot, settings, allBills),
    bill: buildBillView(snapshot, account, settings, null),
    daily: readings.map(({ day, kwh }) => ({ day, kwh })),
    dailyAverage: average === null ? null : { kwh: average, text: `${formatKwh(average)} 度` },
    dailyPeak: peak ? { label: shortDay(peak.day), kwh: `${formatKwh(peak.kwh)} 度` } : null,
    months: bills.flatMap(bill => (bill.kwh === null ? [] : [{ label: `${monthNumber(bill.month)}月`, kwh: bill.kwh }])),
    monthRows: [...bills].reverse().map(bill => ({
      // 跨年时要写明年份，否则去年 12 月和今年 1 月排在一起看不出来。
      label: bill.month.startsWith(latestYear) ? `${monthNumber(bill.month)}月` : `${bill.month.slice(0, 4)}年${monthNumber(bill.month)}月`,
      value: monthRowValue(bill),
    })),
    yearSettled: snapshot.yearKwh === null && snapshot.yearYuan === null ? null : monthRowValue({ month: '', kwh: snapshot.yearKwh, yuan: snapshot.yearYuan, endDay: null }),
  }
}

/** 演示数据：不联网，用来看布局。 */
export function demoSnapshot(now: number): Snapshot {
  const day = (offset: number) => chinaTime(now - offset * DAY_MS).isoDay
  const daily = Array.from({ length: 21 }, (_, i) => ({
    day: day(21 - i),
    kwh: Math.round((9 + 5 * Math.sin(i * 0.9) + (i % 7 === 5 ? 4 : 0)) * 10) / 10,
    yuan: null,
  }))
  const lastMonth = chinaTime(now - 35 * DAY_MS)
  return {
    accountId: 'demo',
    fetchedAt: now,
    balance: { isPrepaid: true, balance: 88.35, amountDue: null, overdue: null },
    monthKwh: 137.4,
    lastBill: { month: `${lastMonth.year}-${String(lastMonth.month).padStart(2, '0')}`, kwh: 305, yuan: 198.25, endDay: null },
    yearKwh: 2178,
    yearYuan: 1215.6,
    yearEstimateKwh: 2315,
    daily,
  }
}
