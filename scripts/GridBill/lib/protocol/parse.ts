/**
 * 把国网接口的原始 JSON 转成领域类型。纯函数，字段口径与 hass-state-grid（MIT）一致。
 * 缺失或占位的值一律变成 null，不会伪造成 0。
 */
import type { Account, Balance, DailyUsage, MonthlyBill, YearlyBilling } from '../types'

type Json = Record<string, any>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : [])

export function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  // 严格匹配：Number('') 和 Number(' ') 都是 0，Number('0x10') 是 16，这些都不能当成读数。
  const text = value.replace(/,/g, '').trim()
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text) ? Number(text) : null
}

const pad2 = (text: string) => text.padStart(2, '0')

/** 接受 20260821、2026-08-21、2026-8-21、2026/08/21，统一成 2026-08-21；不存在的日期返回 null。 */
export function parseDay(value: unknown): string | null {
  const text = String(value ?? '').trim()
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/) ?? text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) ?? text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`
}

/** 接受 202608、2026-08、2026-8、2026/08，统一成 2026-08；不存在的月份返回 null。 */
export function parseMonth(value: unknown): string | null {
  const text = String(value ?? '').trim()
  const match = text.match(/^(\d{4})(\d{2})$/) ?? text.match(/^(\d{4})-(\d{1,2})$/) ?? text.match(/^(\d{4})\/(\d{1,2})$/)
  if (!match) return null
  const month = Number(match[2])
  return month >= 1 && month <= 12 ? `${match[1]}-${pad2(match[2])}` : null
}

function sum(values: Array<number | null>): number | null {
  const numbers = values.filter((v): v is number => v !== null)
  return numbers.length ? Math.round(numbers.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : null
}

const firstOf = (source: Json, ...keys: string[]) => {
  for (const key of keys) {
    const value = source[key]
    if (value !== null && value !== undefined && value !== '') return String(value)
  }
  return ''
}

export function parseAccounts(userInfo: unknown): Account[] {
  if (!isObject(userInfo)) return []
  const seen = new Set<string>()
  const accounts: Account[] = []
  for (const raw of objects(userInfo.powerUserList)) {
    const consNo = firstOf(raw, 'powerUserNo', 'consNo')
    const id = firstOf(raw, 'id', 'userId', 'consNo_dst', 'powerUserNo_dst') || consNo
    if (!consNo || !id || seen.has(id)) continue
    seen.add(id)
    accounts.push({
      id,
      consNo,
      consNoSrc: firstOf(raw, 'powerUserNo_dst', 'consNo_dst') || consNo,
      provinceCode: firstOf(raw, 'proNo', 'provinceId'),
      orgNo: firstOf(raw, 'orgNo'),
      elecType: firstOf(raw, 'elecType', 'constType'),
      name: firstOf(raw, 'consName', 'userName', 'nickname', 'loginAccount') || '用电户号',
    })
  }
  return accounts
}

export const accountConsType = (account: Account) =>
  account.elecType === '04' || (account.elecType === '02' && account.provinceCode === '11102') ? '02' : '01'

export function parseDaily(data: Json): { readings: DailyUsage[]; totalKwh: number | null } {
  const readings: DailyUsage[] = []
  for (const raw of objects(data.sevenEleList)) {
    const day = parseDay(raw.day)
    if (day) readings.push({ day, kwh: parseNumber(raw.dayElePq), yuan: parseNumber(raw.thisAmt) })
  }
  return { readings, totalKwh: parseNumber(data.totalPq) }
}

function parseBill(raw: Json): MonthlyBill | null {
  const month = parseMonth(raw.ym ?? raw.month)
  if (!month) return null
  const settlements = objects(raw.eleList)
  const ends = settlements.map(item => parseDay(item.endDate)).filter((d): d is string => d !== null).sort()
  return {
    month,
    kwh: parseNumber(raw.monthPq ?? raw.monthEleNum ?? raw.pq) ?? sum(settlements.map(item => parseNumber(item.pq))),
    yuan: parseNumber(raw.monthAmt ?? raw.monthEleCost ?? raw.amt) ?? sum(settlements.map(item => parseNumber(item.amt))),
    endDay: ends.length ? ends[ends.length - 1] : null,
  }
}

export function parseYearlyBilling(data: Json): YearlyBilling {
  const rawBills = Array.isArray(data.list) ? data.list : data.mothEleList
  const byMonth = new Map<string, MonthlyBill>()
  for (const raw of objects(rawBills)) {
    const bill = parseBill(raw)
    if (bill) byMonth.set(bill.month, bill)
  }
  const bills = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
  return {
    bills,
    kwh: parseNumber(data.yearPq) ?? sum(bills.map(bill => bill.kwh)),
    yuan: parseNumber(data.yearAmt) ?? sum(bills.map(bill => bill.yuan)),
  }
}

/** consType 为 "1" 是预付费，sumMoney 是余额；其他情况 sumMoney 是应交金额。 */
export function parseBalance(data: Json): Balance | null {
  const raw = objects(data.list)[0]
  if (!raw) return null
  const isPrepaid = String(raw.consType ?? '') === '1'
  const sumMoney = parseNumber(raw.sumMoney)
  const accountBalance = parseNumber(raw.accountBalance)
  const prepayBalance = parseNumber(raw.prepayBal)
  const overdue = parseNumber(raw.historyOwe)
  let balance: number | null
  if (isPrepaid) balance = sumMoney ?? prepayBalance
  else if (accountBalance !== null && accountBalance > 0) balance = accountBalance
  else if (prepayBalance !== null && prepayBalance > 0) balance = prepayBalance
  else balance = null
  return { isPrepaid, balance, amountDue: isPrepaid ? null : sumMoney, overdue: overdue !== null && overdue > 0 ? overdue : null }
}
