/** 跨模块共用的领域类型。 */

/** 户号。只保留查询必需的字段，不存地址。 */
export type Account = {
  id: string
  consNo: string
  /** 历史查询用的源户号 */
  consNoSrc: string
  provinceCode: string
  orgNo: string
  elecType: string
  name: string
}

export type Session = {
  token: string
  userId: string
  province: string
  expiresAt: number
}

export type DailyUsage = { day: string; kwh: number | null; yuan: number | null }

export type MonthlyBill = {
  /** YYYY-MM */
  month: string
  kwh: number | null
  yuan: number | null
  /** 结算周期的最后一天 YYYY-MM-DD，部分地区没有 */
  endDay: string | null
}

export type YearlyBilling = {
  bills: MonthlyBill[]
  kwh: number | null
  yuan: number | null
}

export type Balance = {
  isPrepaid: boolean
  /** 预付费余额，或后付费账户的可用结余 */
  balance: number | null
  /** 后付费应交金额 */
  amountDue: number | null
  /** 历史欠费 */
  overdue: number | null
}

/** 一次完整查询的结果。缺失的数据保持 null，绝不当成 0。 */
export type Snapshot = {
  accountId: string
  fetchedAt: number
  balance: Balance | null
  monthKwh: number | null
  lastBill: MonthlyBill | null
  yearKwh: number | null
  yearYuan: number | null
  /** 今年累计电量估算：已结算 + 结算之后的每日用电，用于阶梯 */
  yearEstimateKwh: number | null
  /** 最近 31 个有读数的日子，时间升序 */
  daily: DailyUsage[]
}

export type Settings = {
  accountId: string | null
  /** 户号 id → 自定义显示名 */
  names: Record<string, string>
  /** 第二档、第三档起点（度/年） */
  tier2: number
  tier3: number
  /** 三档单价（元/度） */
  price1: number
  price2: number
  price3: number
  chartDays: number
  refreshHours: number
}

/**
 * 阶梯默认值是北京“一户一表、不满 1 千伏”的标准。
 * 来源：北京市销售电价表（beijing.gov.cn，2020 年 11 月），每户每月 240、400 度分档，按年累计就是 2880、4800 度。
 */
export const DEFAULT_SETTINGS: Settings = {
  accountId: null,
  names: {},
  tier2: 2880,
  tier3: 4800,
  price1: 0.4883,
  price2: 0.5383,
  price3: 0.7883,
  chartDays: 14,
  refreshHours: 12,
}
