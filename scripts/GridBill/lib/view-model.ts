/** 把数据变成小组件要显示的文字和比例。纯函数，方便测试。 */
import { chinaTime } from './protocol/client'
import type { Account, Balance, Settings, Snapshot } from './types'

export type Tone = 'normal' | 'warning' | 'danger'

export type BillView = {
  title: string
  headline: { label: string; amount: string; tone: Tone }
  monthKwh: string
  lastBill: { label: string; yuan: string } | null
  yearKwh: string
  /** 只有高度为正的才是真实读数；缺失的日子不画柱子，不当成 0 */
  bars: Array<{ day: string; ratio: number }>
  latest: { label: string; kwh: string } | null
  tier: { segments: [number, number, number]; level: 1 | 2 | 3; text: string } | null
  updated: string
  notice: string | null
}

export const PLACEHOLDER = '--'

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

function tier(used: number | null, tier2: number, tier3: number): BillView['tier'] {
  if (used === null || tier2 <= 0 || tier3 <= tier2) return null
  const segments: [number, number, number] = [
    clamp01(used / tier2),
    clamp01((used - tier2) / (tier3 - tier2)),
    clamp01((used - tier3) / (tier3 - tier2)),
  ]
  if (used <= tier2) return { segments, level: 1, text: `第一档 · 距第二档 ${formatKwh(tier2 - used)} 度` }
  if (used <= tier3) return { segments, level: 2, text: `第二档 · 距第三档 ${formatKwh(tier3 - used)} 度` }
  return { segments, level: 3, text: `第三档 · 已超出 ${formatKwh(used - tier3)} 度` }
}

const shortDay = (isoDay: string) => `${Number(isoDay.slice(5, 7))}/${Number(isoDay.slice(8, 10))}`

export function buildBillView(snapshot: Snapshot, account: Account, settings: Settings, notice: string | null): BillView {
  const readings = snapshot.daily.filter((day): day is { day: string; kwh: number; yuan: number | null } => day.kwh !== null)
  const recent = readings.slice(-settings.chartDays)
  const max = Math.max(0, ...recent.map(day => day.kwh))
  const last = recent[recent.length - 1]
  const updated = chinaTime(snapshot.fetchedAt)
  return {
    title: settings.names[account.id] || account.name,
    headline: headline(snapshot.balance),
    monthKwh: formatKwh(snapshot.monthKwh),
    lastBill: snapshot.lastBill
      ? { label: `${Number(snapshot.lastBill.month.slice(5, 7))}月账单`, yuan: formatYuan(snapshot.lastBill.yuan) }
      : null,
    yearKwh: formatKwh(snapshot.yearEstimateKwh ?? snapshot.yearKwh),
    bars: recent.map(day => ({ day: day.day, ratio: max > 0 ? day.kwh / max : 0 })),
    latest: last ? { label: shortDay(last.day), kwh: formatKwh(last.kwh) } : null,
    tier: tier(snapshot.yearEstimateKwh, settings.tier2, settings.tier3),
    updated: `${updated.month}/${updated.day} ${updated.hour}:${updated.minute}`,
    notice,
  }
}

/** 演示数据：不联网，用来看布局。 */
export function demoSnapshot(now: number): Snapshot {
  const day = (offset: number) => chinaTime(now - offset * 86_400_000).isoDay
  const daily = Array.from({ length: 21 }, (_, i) => ({
    day: day(21 - i),
    kwh: Math.round((9 + 5 * Math.sin(i * 0.9) + (i % 7 === 5 ? 4 : 0)) * 10) / 10,
    yuan: null,
  }))
  const lastMonth = chinaTime(now - 35 * 86_400_000)
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
