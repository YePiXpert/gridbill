/**
 * 业务策略：什么时候可以联网、什么时候必须停下来。
 *
 * 后台（小组件）的规则，也是这个脚本最重要的安全设计：
 *   1. 账号被拒、要求短信验证、安全校验失败，都只尝试一次，之后完全不再联网，直到你在脚本里处理。
 *   2. 自动登录最多 12 小时一次；同一户号的查询最多 30 分钟一次。
 *   3. 绝不自动发短信。
 *   4. 密码验证通过之后才保存，输错的密码不会被小组件反复拿去试。
 *   5. 验证码登录不保存密码。没有保存过密码的账号到期后，小组件不联网，只提示重新登录。
 */
import { md5Hex } from './protocol/bytes'
import { APP_KEYS, chinaTime, SgccClient, SgccError, type Transport } from './protocol/client'
import { parseNumber } from './protocol/parse'
import { DEFAULT_SETTINGS, type Account, type DailyUsage, type Session, type Settings, type Snapshot } from './types'
import { buildBillView, demoSnapshot, type BillView } from './view-model'
import { loadSettings, vault, type Block } from './vault'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** 比柱状图最多的 21 天宽一些：国网的每日数据有延迟，缺的日子也不会算进去。 */
const ROLLING_WINDOW_DAYS = 34
const MIN_QUERY_INTERVAL = 30 * MINUTE
const MIN_AUTO_LOGIN_INTERVAL = 12 * HOUR
const SESSION_MARGIN = 5 * MINUTE
const RETRY_AFTER_FAILURE = HOUR
/** 小组件一次运行里花在联网上的总时间。官方文档没写上限，只说扩展进程随时可能被结束。 */
const WIDGET_NETWORK_BUDGET = 25 * 1000
const LOGIN_EXPIRED = '登录已过期，需要重新登录'

type Attempt<T> = { ok: true; value: T } | { ok: false }

export type WidgetModel =
  | { state: 'ok'; view: BillView; nextRefresh: Date }
  | { state: 'signedOut'; nextRefresh: Date }
  | { state: 'error'; message: string; nextRefresh: Date }

export type LoginState = {
  phone: string
  accounts: Account[]
  signedIn: boolean
  /** 保存了密码 MD5，登录到期后可以自动续。 */
  canAutoLogin: boolean
  sessionExpiresAt: number | null
  block: Block | null
}

/** 小组件参数：官方预览要求参数是 JSON 字符串，桌面上则是用户手写的文本，两种都接受。 */
export function normalizeParameter(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (text.startsWith('"')) {
    try {
      const value = JSON.parse(text)
      if (typeof value === 'string') return value.trim()
    } catch {
      // 不是 JSON，按普通文本处理
    }
  }
  return text
}

/** 留空用默认户号；数字是第几户；其他按显示名或户号尾号匹配。指定了却找不到时返回 null，不偷偷显示别的户。 */
export function pickAccount(accounts: Account[], settings: Settings, parameter: string): Account | null {
  if (!parameter) return accounts.find(a => a.id === settings.accountId) ?? accounts[0] ?? null
  if (/^\d{1,2}$/.test(parameter)) return accounts[Number(parameter) - 1] ?? null
  return (
    accounts.find(a => settings.names[a.id] === parameter || a.name === parameter) ??
    accounts.find(a => parameter.length >= 4 && a.consNoSrc.endsWith(parameter)) ??
    null
  )
}

function monthRange(year: number, month: number): [string, string] {
  const p = (n: number) => String(n).padStart(2, '0')
  return [`${year}-${p(month)}-01`, `${year}-${p(month)}-${p(new Date(Date.UTC(year, month, 0)).getUTCDate())}`]
}

const previousMonthRange = (year: number, month: number) => (month === 1 ? monthRange(year - 1, 12) : monthRange(year, month - 1))

const lastDayOfMonth = (yearMonth: string) => {
  const [year, month] = yearMonth.split('-').map(Number)
  return monthRange(year, month)[1]
}

function sumKwh(days: DailyUsage[]): number {
  return days.reduce((total, day) => total + (day.kwh ?? 0), 0)
}

const round = (value: number) => Math.round(value * 100) / 100

/** 显示在小组件上，要一行放得下；详细原因在脚本的账号区里。 */
function blockMessage(block: Block): string {
  switch (block.kind) {
    case 'credentials':
      return '密码被拒绝，需要重新登录'
    case 'device':
      return '需要短信验证，请打开脚本'
    case 'risk':
      return '安全校验未通过，请打开脚本'
  }
}

export function createService(
  transport: Transport,
  options: { now?: () => number; keys?: typeof APP_KEYS } = {},
) {
  const now = options.now ?? Date.now
  let deadlineAt: number | undefined

  const clientFor = (phone: string) =>
    new SgccClient({
      phone,
      transport,
      now,
      deadlineAt,
      keys: options.keys,
      loadDevice: () => vault.device(phone),
      saveDevice: state => vault.saveDevice(phone, state),
    })

  /** 三类错误都需要人来处理，记下来后后台就不再联网。 */
  function recordFailure(error: unknown): void {
    if (error instanceof SgccError && (error.kind === 'credentials' || error.kind === 'device' || error.kind === 'risk')) {
      vault.saveGate({ ...vault.gate(), block: { kind: error.kind, message: error.message, at: now() } })
    }
  }

  async function login(mode: 'background' | 'interactive'): Promise<Session> {
    const credentials = vault.credentials()
    if (!credentials) throw new SgccError('credentials', 'no-credentials', '请先登录')
    // 没有保存密码就没法自动续。短信必须由用户发起，所以这里不联网，只提示。
    if (!credentials.passwordMd5) throw new SgccError('session', 'no-password', LOGIN_EXPIRED)
    if (mode === 'background') {
      const gate = vault.gate()
      if (now() - gate.lastAutoLoginAt < MIN_AUTO_LOGIN_INTERVAL) {
        throw new SgccError('session', 'throttled', '登录已过期，稍后自动重试')
      }
      // 先记录再联网：即使进程在请求途中被系统结束，这次尝试也算数。
      vault.saveGate({ ...gate, lastAutoLoginAt: now() })
    }
    const { session, accounts } = await clientFor(credentials.phone).login(credentials.passwordMd5)
    vault.saveSession(session)
    if (accounts.length) vault.saveAccounts(accounts)
    vault.saveGate({ ...vault.gate(), block: null })
    return session
  }

  function validSession(): Session | null {
    const session = vault.session()
    return session?.token && session.expiresAt > now() + SESSION_MARGIN ? session : null
  }

  async function fetchSnapshot(session: Session, account: Account, settings: Settings): Promise<Snapshot> {
    const credentials = vault.credentials()
    if (!credentials) throw new SgccError('credentials', 'no-credentials', '请先登录')
    const client = clientFor(credentials.phone)
    const t = now()
    const today = chinaTime(t)
    const previous = vault.snapshot(account.id)
    const previousSameYear = previous && chinaTime(previous.fetchedAt).year === today.year ? previous : null

    // 单个接口报错不影响其他数据：不同地区支持的接口不一样。
    // 注意：Scripting 按 TSX 解析 .ts 文件，这里不能写成 async <T>(...) => 形式的泛型箭头函数。
    let firstProblem: SgccError | null = null
    async function attempt<T>(work: () => Promise<T>, tolerateNetwork = false): Promise<Attempt<T>> {
      try {
        return { ok: true, value: await work() }
      } catch (error) {
        if (error instanceof SgccError && (error.kind === 'business' || (tolerateNetwork && error.kind === 'network'))) {
          firstProblem = firstProblem ?? error
          return { ok: false }
        }
        throw error
      }
    }

    const [monthStart, monthEnd] = monthRange(today.year, today.month)
    // 这个户号查到过每日数据，这次报错多半是临时的：整次作废、保留缓存、稍后重试，不用空数据覆盖。
    // 从来没查到过的话，可能是地区不支持，不能因此连余额都看不到。
    const dailyQuery = () => client.dailyUsage(session, account, monthStart, monthEnd)
    const current: Attempt<{ readings: DailyUsage[]; totalKwh: number | null }> = previous?.daily.length
      ? { ok: true, value: await dailyQuery() }
      : await attempt(dailyQuery)
    const currentDaily = current.ok ? current.value : null

    const billingResult = await attempt(() => client.monthlyBills(session, account, today.year))
    const billing = billingResult.ok ? billingResult.value : null
    let lastBill = billing ? billing.bills[billing.bills.length - 1] ?? null : previous?.lastBill ?? null
    if (billing && !lastBill) {
      const lastYear = await attempt(() => client.monthlyBills(session, account, today.year - 1))
      lastBill = lastYear.ok ? lastYear.value.bills[lastYear.value.bills.length - 1] ?? null : previous?.lastBill ?? null
    }
    const settledThrough = lastBill ? lastBill.endDay ?? lastDayOfMonth(lastBill.month) : null

    // 合并多次查询的结果：后查到的覆盖先查到的，但占位行不能盖掉真实读数。
    const byDay = new Map<string, DailyUsage>()
    const merge = (rows: DailyUsage[]) => {
      for (const row of rows) {
        if (row.kwh !== null || !byDay.has(row.day)) byDay.set(row.day, row)
      }
    }
    const usableDays = () => [...byDay.values()].filter(day => day.kwh !== null).length
    // 先放上次存下的读数：这次接口少返回几天，柱状图和阶梯估算也不会倒退，攒够之后还能少发请求。
    merge(previous?.daily ?? [])
    merge(currentDaily?.readings ?? [])

    // 上个月还没出账时，阶梯估算要用它的每日数据。缓存里可能缺月底那几天，所以必须查整月。
    const [previousStart, previousEnd] = previousMonthRange(today.year, today.month)
    const previousUnsettled = settledThrough !== null && settledThrough < previousEnd
    if (previousUnsettled || usableDays() < settings.chartDays) {
      const lastMonth = await attempt(() => client.dailyUsage(session, account, previousStart, previousEnd))
      if (lastMonth.ok) merge(lastMonth.value.readings)
    }

    // 还不够就再试一次滚动窗口。真机上出现过查完整月仍只有几天读数的情况，原因还没查明，“诊断每日数据”就是查这个的。
    // 这一步只是补充，连网络错误也不能让整次更新作废。
    if (usableDays() < settings.chartDays) {
      const rolling = await attempt(() => client.dailyUsage(session, account, chinaTime(t - ROLLING_WINDOW_DAYS * DAY).isoDay, today.isoDay), true)
      if (rolling.ok) merge(rolling.value.readings)
    }

    // 余额是附加数据，接口也因地区而异，所以连网络错误都容忍。
    const balanceResult = await attempt(() => client.balance(session, account), true)

    if (!current.ok && !billingResult.ok && !balanceResult.ok && byDay.size === 0) {
      throw firstProblem ?? new SgccError('business', 'empty', '国网没有返回任何数据')
    }

    const daily = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
    const thisMonth = daily.filter(day => day.day >= monthStart && day.day <= monthEnd)
    const monthKwh = currentDaily?.totalKwh ?? (thisMonth.some(day => day.kwh !== null) ? round(sumKwh(thisMonth)) : null)

    // 阶梯要的是今年累计：已结算的加上结算之后还没出账的每日用电。
    let yearEstimateKwh = previousSameYear?.yearEstimateKwh ?? null
    if (billing) {
      const yearPrefix = `${today.year}-`
      const cutoff = lastBill && lastBill.month.startsWith(yearPrefix) ? (settledThrough as string) : `${today.year - 1}-12-31`
      const unsettled = daily.filter(day => day.day.startsWith(yearPrefix) && day.day > cutoff)
      yearEstimateKwh = round((billing.kwh ?? 0) + sumKwh(unsettled))
    }

    // 这次失败的接口保留上次的值，不让一次临时错误把好数据冲掉。
    return {
      accountId: account.id,
      fetchedAt: t,
      balance: balanceResult.ok ? balanceResult.value : previous?.balance ?? null,
      monthKwh,
      lastBill,
      yearKwh: billing ? billing.kwh : previousSameYear?.yearKwh ?? null,
      yearYuan: billing ? billing.yuan : previousSameYear?.yearYuan ?? null,
      yearEstimateKwh,
      daily: daily.slice(-31),
    }
  }

  /** 会话过期时重新登录并重试一次，第二次失败就交给调用方。 */
  async function queryWithSession(mode: 'background' | 'interactive', account: Account, settings: Settings): Promise<Snapshot> {
    const session = validSession() ?? (await login(mode))
    try {
      return await fetchSnapshot(session, account, settings)
    } catch (error) {
      if (!(error instanceof SgccError && error.kind === 'session')) throw error
      vault.clearSession()
      return fetchSnapshot(await login(mode), account, settings)
    }
  }

  function state(): LoginState {
    const credentials = vault.credentials()
    const session = validSession()
    return {
      phone: credentials?.phone ?? '',
      accounts: vault.accounts(),
      signedIn: !!credentials,
      canAutoLogin: !!credentials?.passwordMd5,
      sessionExpiresAt: session?.expiresAt ?? null,
      block: vault.gate().block,
    }
  }

  /** 用户手动登录成功后保存结果，并打开闸门。 */
  function saveSignIn(phone: string, passwordMd5: string | null, session: Session, accounts: Account[]): void {
    const previous = vault.credentials()
    if (previous && previous.phone !== phone) {
      // 换了账号：旧账号的用电数据不再保留。
      for (const account of vault.accounts()) vault.removeSnapshot(account.id)
    }
    vault.saveCredentials({ phone, passwordMd5 })
    vault.saveSession(session)
    vault.saveAccounts(accounts)
    vault.saveGate({ block: null, lastAutoLoginAt: 0 })
    for (const account of accounts) vault.saveLastAttempt(account.id, 0)
  }

  return {
    state,

    /** 用户在界面上发起。验证通过后才保存账号和密码 MD5。 */
    async signIn(phone: string, password: string, sms?: { code: string; codeKey: string }): Promise<LoginState> {
      if (!phone || !password) throw new SgccError('credentials', 'empty', '请填写账号和密码')
      // 格式不对就不发给国网，免得白白消耗一次登录尝试。
      if (sms && !/^\d{6}$/.test(sms.code)) throw new SgccError('business', 'bad-code', '验证码应该是 6 位数字')
      const passwordMd5 = md5Hex(password)
      const { session, accounts } = await clientFor(phone).login(passwordMd5, sms)
      saveSignIn(phone, passwordMd5, session, accounts)
      return state()
    },

    /** 用户在界面上发起的验证码登录。这条路径不碰密码，同一手机号之前验证过的密码 MD5 继续留着，到期还能自动续。 */
    async signInWithCode(phone: string, code: string, codeKey: string): Promise<LoginState> {
      if (!phone) throw new SgccError('credentials', 'empty', '请填写手机号')
      if (!/^\d{6}$/.test(code)) throw new SgccError('business', 'bad-code', '验证码应该是 6 位数字')
      if (!codeKey) throw new SgccError('business', 'no-code-key', '请先发送验证码')
      const { session, accounts } = await clientFor(phone).smsLogin(code, codeKey)
      const previous = vault.credentials()
      // 刚被国网拒绝的密码不能留着，否则到期后小组件又会拿它去试。
      const passwordMd5 = previous?.phone === phone && vault.gate().block?.kind !== 'credentials' ? previous.passwordMd5 : null
      saveSignIn(phone, passwordMd5, session, accounts)
      return state()
    },

    /** 只能由用户点按钮触发，返回一次性 codeKey，不落地。 */
    requestVerificationCode(phone: string): Promise<string> {
      return clientFor(phone).sendDeviceSms()
    },

    /** 只能由用户点按钮触发，返回一次性 codeKey，不落地。 */
    requestLoginCode(phone: string): Promise<string> {
      return clientFor(phone).sendLoginSms()
    },

    /** 用户点“立即刷新”。不受后台频率限制，但被闸门拦下时要先重新登录。 */
    async refreshNow(accountId?: string | null): Promise<Snapshot> {
      const settings = loadSettings()
      const block = vault.gate().block
      if (block) throw new SgccError(block.kind, 'blocked', blockMessage(block))
      const accounts = vault.accounts()
      const account = accounts.find(a => a.id === (accountId ?? settings.accountId)) ?? accounts[0]
      if (!account) throw new SgccError('credentials', 'no-account', '没有可用的户号，请重新登录')
      try {
        const snapshot = await queryWithSession('interactive', account, settings)
        vault.saveSnapshot(snapshot)
        vault.saveLastAttempt(account.id, now())
        return snapshot
      } catch (error) {
        recordFailure(error)
        throw error
      }
    },

    /**
     * 用户点“诊断每日数据”时运行：分别按本月、上月、滚动窗口查一次，报告国网实际返回了什么。
     * 只有条数、日期、读数和字段名，没有账号、户号和登录凭证，可以放心截图。
     * 和其他联网操作守同样的规矩：闸门关着就不联网，遇到风控等问题要把闸门关上。
     */
    async diagnoseDaily(accountId?: string | null): Promise<string> {
      const block = vault.gate().block
      if (block) throw new SgccError(block.kind, 'blocked', blockMessage(block))
      const credentials = vault.credentials()
      const accounts = vault.accounts()
      const account = accounts.find(a => a.id === accountId) ?? accounts[0]
      if (!credentials || !account) throw new SgccError('credentials', 'no-account', '请先登录')
      try {
        const session = validSession() ?? (await login('interactive'))
        const client = clientFor(credentials.phone)
        const t = now()
        const today = chinaTime(t)
        const probes: Array<[string, string, string]> = [
          ['本月', ...monthRange(today.year, today.month)],
          ['上月', ...previousMonthRange(today.year, today.month)],
          ['最近35天', chinaTime(t - ROLLING_WINDOW_DAYS * DAY).isoDay, today.isoDay],
        ]
        const lines: string[] = []
        for (const [label, start, end] of probes) {
          lines.push(`【${label}】${start} ~ ${end}`)
          try {
            const raw = await client.dailyRaw(session, account, start, end)
            const rows: Array<Record<string, unknown>> = Array.isArray(raw.sevenEleList) ? raw.sevenEleList : []
            const valid = rows.filter(row => parseNumber(row.dayElePq) !== null).length
            lines.push(`返回 ${rows.length} 行，有读数 ${valid} 行，totalPq=${String(raw.totalPq)}`)
            lines.push(`响应字段：${Object.keys(raw).join(', ')}`)
            if (rows.length > 0) {
              const describe = (row: Record<string, unknown>) => `${String(row.day)}=${String(row.dayElePq)}`
              lines.push(`前两行：${rows.slice(0, 2).map(describe).join('  ')}`)
              lines.push(`后两行：${rows.slice(-2).map(describe).join('  ')}`)
              lines.push(`行字段：${Object.keys(rows[0]).join(', ')}`)
            }
          } catch (error) {
            if (error instanceof SgccError && error.kind !== 'business' && error.kind !== 'network') throw error
            lines.push(`失败：${error instanceof SgccError ? `${error.code} ${error.message}` : '未知错误'}`)
          }
        }
        return lines.join('\n')
      } catch (error) {
        recordFailure(error)
        throw error
      }
    },

    eraseAll(): void {
      vault.eraseAll()
    },

    /** 小组件入口：除非确实需要且允许，否则不碰网络。 */
    async loadWidgetModel(rawParameter: unknown): Promise<WidgetModel> {
      const t = now()
      const settings = loadSettings()
      const parameter = normalizeParameter(rawParameter)
      const nextNormal = new Date(t + settings.refreshHours * HOUR)
      const nextRetry = new Date(t + RETRY_AFTER_FAILURE)

      if (parameter.toLowerCase() === 'demo') {
        const account: Account = { id: 'demo', consNo: '0000', consNoSrc: '0000', provinceCode: '', orgNo: '', elecType: '01', name: '演示' }
        return { state: 'ok', view: buildBillView(demoSnapshot(t), account, DEFAULT_SETTINGS, null), nextRefresh: nextNormal }
      }

      if (!vault.credentials()) return { state: 'signedOut', nextRefresh: nextRetry }
      const account = pickAccount(vault.accounts(), settings, parameter)
      if (!account) return { state: 'error', message: parameter ? `找不到户号“${parameter}”` : '没有户号，请打开脚本重新登录', nextRefresh: nextRetry }

      const cached = vault.snapshot(account.id)
      const render = (notice: string | null, next: Date): WidgetModel =>
        cached
          ? { state: 'ok', view: buildBillView(cached, account, settings, notice), nextRefresh: next }
          : { state: 'error', message: notice ?? '暂时没有数据', nextRefresh: next }

      const block = vault.gate().block
      if (cached && t - cached.fetchedAt < settings.refreshHours * HOUR) {
        return render(block ? blockMessage(block) : null, nextNormal)
      }
      if (block) return render(blockMessage(block), nextNormal)
      // 没有保存密码就不可能自己恢复，不能显示“稍后自动重试”。
      if (!validSession() && !vault.credentials()?.passwordMd5) return render(LOGIN_EXPIRED, nextNormal)
      if (t - vault.lastAttempt(account.id) < MIN_QUERY_INTERVAL) return render(cached ? null : '稍后自动重试', nextRetry)

      vault.saveLastAttempt(account.id, t)
      deadlineAt = t + WIDGET_NETWORK_BUDGET
      try {
        const snapshot = await queryWithSession('background', account, settings)
        vault.saveSnapshot(snapshot)
        return { state: 'ok', view: buildBillView(snapshot, account, settings, null), nextRefresh: nextNormal }
      } catch (error) {
        recordFailure(error)
        const current = vault.gate().block
        if (current) return render(blockMessage(current), nextNormal)
        const text = error instanceof SgccError && error.kind === 'session' ? error.message : '更新失败，稍后重试'
        return render(text, nextRetry)
      } finally {
        deadlineAt = undefined
      }
    },
  }
}

export type Service = ReturnType<typeof createService>
