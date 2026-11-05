/** 把数据变成小组件要显示的文字和比例。纯函数，方便测试。 */
import { chinaTime } from './protocol/client'
import { isOpaque } from './protocol/parse'
import type { Account, Balance, Settings, Snapshot } from './types'

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

export const PLACEHOLDER = '--'

const DAY_MS = 86_400_000
/** 读数太少时平均值没有参考价值。 */
const MIN_DAYS_FOR_AVERAGE = 3
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

function tier(used: number | null, { tier2, tier3 }: Settings, pace: Pace | null): BillView['tier'] {
  if (used === null || tier2 <= 0 || tier3 <= tier2) return null
  const segments: [number, number, number] = [
    clamp01(used / tier2),
    clamp01((used - tier2) / (tier3 - tier2)),
    clamp01((used - tier3) / (tier3 - tier2)),
  ]
  if (used <= tier2) return { segments, level: 1, label: '第一档', ...nextTierHint(tier2 - used, '第二档', pace) }
  if (used <= tier3) return { segments, level: 2, label: '第二档', ...nextTierHint(tier3 - used, '第三档', pace) }
  return { segments, level: 3, label: '第三档', hint: `已超出 ${formatKwh(used - tier3)} 度`, urgent: false }
}

/** 本月用电是今年累计的最后一段，看这一段落在哪几档，分别计价。 */
function monthCost(monthKwh: number | null, yearKwh: number, { tier2, tier3, price1, price2, price3 }: Settings): string | null {
  if (monthKwh === null) return null
  const to = Math.max(yearKwh, monthKwh)
  const from = to - monthKwh
  const within = (low: number, high: number) => Math.max(0, Math.min(to, high) - Math.max(from, low))
  return formatYuan(within(0, tier2) * price1 + within(tier2, tier3) * price2 + within(tier3, Infinity) * price3)
}

const shortDay = (isoDay: string) => `${Number(isoDay.slice(5, 7))}/${Number(isoDay.slice(8, 10))}`

/** 以前登录保存的户号可能还是加密串，显示时再挡一次。 */
export function accountDisplayName(account: Account): string {
  return isOpaque(account.name) ? '用电户号' : account.name
}

export function buildBillView(snapshot: Snapshot, account: Account, settings: Settings, notice: string | null): BillView {
  const readings = snapshot.daily.filter((day): day is { day: string; kwh: number; yuan: number | null } => day.kwh !== null)
  const recent = readings.slice(-settings.chartDays)
  const max = Math.max(0, ...recent.map(day => day.kwh))
  const last = recent[recent.length - 1]
  const updated = chinaTime(snapshot.fetchedAt)
  const average = recent.length >= MIN_DAYS_FOR_AVERAGE ? recent.reduce((total, day) => total + day.kwh, 0) / recent.length : null
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
