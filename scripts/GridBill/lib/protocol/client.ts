/**
 * 网上国网 Android App 3.2.3 协议客户端。
 * 请求信封、请求头和接口参数移植自 hass-state-grid（MIT），详见 NOTICE.md。
 *
 * 这里只负责“发请求、解响应、分类错误”，什么时候该发请求由 service.ts 决定。
 */
import type { Account, Balance, DailyUsage, Session, YearlyBilling } from '../types'
import { aes256EcbEncrypt } from './classic'
import { fromHex, md5Hex, randomBelow, randomBytes, randomString, toHex, utf8Decode, utf8Encode } from './bytes'
import { sm2Decrypt, sm2Encrypt, sm3Hex, sm4DecryptEcb, sm4EncryptEcb } from './gm'
import { accountConsType, parseAccounts, parseBalance, parseDaily, parseYearlyBilling } from './parse'
import { appGuid, createDeviceState, DEVICE_MODEL, withFreshToken, type DeviceState } from './turing'

export const API_BASE = 'https://csc-service.sgcc.com.cn:28630/'

const PATH_LOGIN = 'emss-uia-center-front/member/c2/f01'
const PATH_SMS = 'emss-uia-center-front/member/c1/f01'
const PATH_DAILY = 'emss-bia-bill-front/member/c11/f01'
const PATH_MONTHLY = 'emss-bia-bill-front/member/c51/f04'
const PATH_BALANCE = 'emss-bia-balance-front/member/c16/f01'

/** App 内置的公开常量，所有安装都相同，不是你的私密信息。 */
export const APP_KEYS = {
  serverPublicKey:
    '0409C10D38CF7B4E28097EAAA519E3157C9B4E72194CD13BD11932CE40ED5624AFEFF27F78893E4C4FC2029DA147AB6CEAE0CDC8E3A547EFCDC5AB91757FE1CA60',
  clientPrivateKey: '50C4AF48DF75808050729977AA6BC127DC21A404755C660B94222F9D50FA4A75',
}
const CHECK_CODE_KEY = utf8Encode('LNPO+ISJ+QeqNemFK+3OMUdexSn2i6pB')
const GUID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const DEFAULT_TOKEN_LIFETIME_S = 1_296_000
const REQUEST_TIMEOUT_S = 20

/**
 * network     网络或响应异常，稍后重试即可
 * session     登录已失效，可以用保存的凭据重新登录
 * device      国网要求新设备短信验证（4006）
 * risk        国网安全校验未通过（RK 开头的代码，提示语常写成“网络连接超时”，但不是真的网络问题）
 * credentials 账号或密码被拒绝
 * business    单个接口报错，其他接口可能仍然可用
 */
export type SgccErrorKind = 'network' | 'session' | 'device' | 'risk' | 'credentials' | 'business'

export class SgccError extends Error {
  kind: SgccErrorKind
  code: string

  constructor(kind: SgccErrorKind, code: string, message: string) {
    super(message)
    this.kind = kind
    this.code = code
  }
}

export type TransportRequest = { headers: Record<string, string>; body: string; timeoutSeconds: number }
export type Transport = (url: string, request: TransportRequest) => Promise<{ status: number; text: string }>

export type ClientOptions = {
  phone: string
  transport: Transport
  loadDevice: () => DeviceState | null
  saveDevice: (state: DeviceState) => void
  keys?: typeof APP_KEYS
  now?: () => number
  /** 超过这个时间就不再发新请求，返回 network 错误。小组件进程随时可能被系统结束。 */
  deadlineAt?: number
}

/* ---------- 时间：协议固定使用北京时间 ---------- */

export function chinaTime(ms: number) {
  const d = new Date(ms + 8 * 3600 * 1000)
  const p = (n: number, width = 2) => String(n).padStart(width, '0')
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  const hour = p(d.getUTCHours())
  const minute = p(d.getUTCMinutes())
  const seconds = `${year}${p(month)}${p(day)}${hour}${minute}${p(d.getUTCSeconds())}`
  return { year, month, day, hour, minute, seconds, millis: seconds + p(d.getUTCMilliseconds(), 3), isoDay: `${year}-${p(month)}-${p(day)}` }
}

/* ---------- 信封 ---------- */

/** App 用 UUID 的 32 位十六进制文本当 SM4 密钥，并且只取前 16 个 ASCII 字符。 */
function newKeyText(): string {
  const v = randomBytes(16)
  v[6] = (v[6] & 0x0f) | 0x40
  v[8] = (v[8] & 0x3f) | 0x80
  return toHex(v)
}
const keyBytes = (keyText: string) => utf8Encode(keyText.slice(0, 16))

export function buildEnvelope(payload: unknown, serverPublicKey: string, keyText = newKeyText(), timestamp = String(Date.now())) {
  const data = toHex(sm4EncryptEcb(utf8Encode(JSON.stringify(payload)), keyBytes(keyText))).toUpperCase()
  const skey = sm2Encrypt(utf8Encode(keyText), serverPublicKey)
  return { data, sign: sm3Hex(skey + data + timestamp), skey, timestamp }
}

/**
 * 超过 15 位的整数（用户 ID、户号）转成字符串再解析，否则 JS 的 number 会悄悄丢精度。
 * 正则先匹配字符串，所以字符串里的数字不受影响。
 */
export function parseJsonKeepingLongIntegers(text: string): unknown {
  return JSON.parse(
    text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => (/^-?\d{16,}$/.test(token) ? `"${token}"` : token)),
  )
}

export function openEnvelope(outer: { respKey: unknown; encryptData: unknown }, clientPrivateKey: string): unknown {
  const keyText = utf8Decode(sm2Decrypt(String(outer.respKey), clientPrivateKey))
  if (!/^[0-9a-fA-F]{32}$/.test(keyText)) throw new Error('响应密钥格式无效')
  return parseJsonKeepingLongIntegers(utf8Decode(sm4DecryptEcb(fromHex(String(outer.encryptData)), keyBytes(keyText))))
}

/* ---------- 登录相关的明文结构 ---------- */

export function generateCheckCode(account: string, timestamp: number, random24?: string): string {
  let prefix = random24
  if (!prefix) {
    let value = 0n
    for (const byte of randomBytes(8)) value = (value << 8n) | BigInt(byte)
    prefix = String(value & ((1n << 63n) - 1n)).padStart(24, '0')
  }
  return prefix + toHex(aes256EcbEncrypt(utf8Encode(`${account}${timestamp}`), CHECK_CODE_KEY))
}

export function buildLoginParams(phone: string, passwordMd5: string, timestamp: number, sms?: { code: string; codeKey: string }, random24?: string) {
  const pushId = '000000,000000'
  return {
    quInfo: {
      code: sms?.code ?? '',
      codeKey: sms?.codeKey ?? '',
      account: phone,
      password: passwordMd5,
      optSys: 'Android',
      pushId,
      addressCity: '',
      addressProvince: '',
      addressRegion: '',
    },
    uscInfo: {
      isEncrypt: 'false',
      devciceIp: '127.0.0.1',
      devciceId: '000000',
      tenant: 'state_grid',
      member: '2202',
      optSys: 'Android 13',
      operatorType: '',
      devciceName: DEVICE_MODEL,
      pushId,
    },
    checkCode: generateCheckCode(phone, timestamp, random24),
    avalonValidCode: '',
  }
}

function javaHashMapOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(javaHashMapOrder)
  if (typeof value !== 'object' || value === null) return value
  const buckets = new Map<number, string[]>()
  for (const key of Object.keys(value)) {
    let hash = 0
    for (const char of key) hash = (Math.imul(31, hash) + (char.codePointAt(0) as number)) >>> 0
    hash = (hash ^ (hash >>> 16)) >>> 0
    const bucket = hash & 15
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), key])
  }
  const ordered: Record<string, unknown> = {}
  for (const bucket of [...buckets.keys()].sort((a, b) => a - b)) {
    for (const key of buckets.get(bucket) as string[]) ordered[key] = javaHashMapOrder((value as Record<string, unknown>)[key])
  }
  return ordered
}

/** App 用外层按键排序、内层按 Java HashMap 遍历顺序序列化后取 MD5。 */
export function loginHeaderMd5(params: Record<string, unknown>): string {
  const material = Object.keys(params)
    .sort()
    .map(key => key + JSON.stringify(javaHashMapOrder(params[key])))
    .join('')
  return md5Hex(material)
}

/* ---------- 错误分类 ---------- */

type Json = Record<string, any>

/** 字段存在但值是 null 时也当作错误码，不当作成功，和上游 str(dict.get(key)) 的结果一致。 */
const codeOf = (source: Json, key: string, fallback = '') => (key in source ? String(source[key]) : fallback)

function unwrap(response: Json): Json {
  const topCode = codeOf(response, 'code')
  const data: Json = typeof response.data === 'object' && response.data !== null ? response.data : {}
  const server: Json | null = typeof data.srvrt === 'object' && data.srvrt !== null ? data.srvrt : null
  const serverCode = server ? codeOf(server, 'resultCode') : ''
  const message = String((server ? server.resultMessage : response.message) ?? '')
  const code = serverCode || topCode
  if (code === '4006') throw new SgccError('device', code, '国网要求验证新设备')
  // 上游只记录了 RK008。真机上还见过提示语相同的 RK007，同一系列都按风控处理：宁可停下，也不要继续试。
  if (/^RK\d+$/.test(code)) throw new SgccError('risk', code, `国网安全校验未通过（${code}）`)
  if (code === '-200' || code === '-201') throw new SgccError('session', code, '登录已失效')
  if (serverCode && serverCode !== '0000') throw new SgccError('business', serverCode, message || '国网返回错误')
  if (topCode !== '' && topCode !== '1') throw new SgccError('business', topCode, message || '国网返回错误')
  return data
}

function unwrapBusiness(response: Json, operation: string): Json {
  const data = unwrap(response)
  const code = codeOf(data, 'rtnCode', codeOf(data, 'returnCode'))
  if (!['', '0', '1', '0000', '000000'].includes(code)) {
    throw new SgccError('business', code, String(data.rtnMsg ?? data.returnMsg ?? `${operation}失败`))
  }
  return data
}

/* ---------- 客户端 ---------- */

export class SgccClient {
  private options: ClientOptions
  private keys: typeof APP_KEYS
  private now: () => number

  constructor(options: ClientOptions) {
    this.options = options
    this.keys = options.keys ?? APP_KEYS
    this.now = options.now ?? Date.now
  }

  /** App 在每次请求前都会检查 4 小时的令牌缓存，这里同样处理。 */
  private device(): DeviceState {
    const stored = this.options.loadDevice()
    const base = stored ?? createDeviceState(this.now())
    const fresh = withFreshToken(base, this.now())
    if (fresh !== stored) this.options.saveDevice(fresh)
    return fresh
  }

  private headers(session: Session | null, loginParams: Record<string, unknown> | null): Record<string, string> {
    const device = this.device()
    const time = chinaTime(this.now())
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=UTF-8',
      timeStamp: loginParams ? time.seconds : time.millis + randomString(6, '0123456789'),
      t: session?.token ?? '',
      userid: session?.userId ?? '0',
      AppGuid: appGuid(device.seedHex),
      AppGuidNew: randomString(40, GUID_ALPHABET) + time.millis + String(100 + randomBelow(900)),
      security: 'android',
      appcode: 'WSGW-SG1001-APP',
      datacenter: '99',
      AccessMethod: 'App',
      deviceTokenTX: device.token?.value ?? '',
      deviceTokenTXTime: device.token?.time ?? '',
      province: session?.province ?? '',
      version: '3.2.3',
      wsgwType: 'android',
      ip: '127.0.0.1',
      os: 'android',
      'User-Agent': 'okhttp/3.14.9',
    }
    if (loginParams) headers.md5 = loginHeaderMd5(loginParams)
    return headers
  }

  private async post(path: string, payload: unknown, session: Session | null, loginParams: Record<string, unknown> | null = null): Promise<Json> {
    const { deadlineAt } = this.options
    const remainingSeconds = deadlineAt === undefined ? REQUEST_TIMEOUT_S : Math.ceil((deadlineAt - this.now()) / 1000)
    if (remainingSeconds <= 0) throw new SgccError('network', 'deadline', '这次更新超时')
    const envelope = buildEnvelope(payload, this.keys.serverPublicKey, undefined, String(this.now()))
    const request = { headers: this.headers(session, loginParams), body: JSON.stringify(envelope), timeoutSeconds: Math.min(REQUEST_TIMEOUT_S, remainingSeconds) }
    let result: { status: number; text: string }
    try {
      result = await this.options.transport(API_BASE + path, request)
    } catch {
      throw new SgccError('network', 'transport', '连不上国网服务器')
    }
    if (result.status >= 500) throw new SgccError('network', String(result.status), '国网服务器暂时不可用')
    let outer: Json
    try {
      outer = JSON.parse(result.text)
    } catch {
      throw new SgccError('network', 'bad-json', '国网返回了无法识别的内容')
    }
    if (!outer?.respKey || !outer?.encryptData) throw new SgccError('network', 'no-envelope', '国网返回了无法识别的内容')
    try {
      const plain = openEnvelope({ respKey: outer.respKey, encryptData: outer.encryptData }, this.keys.clientPrivateKey)
      if (typeof plain !== 'object' || plain === null) throw new Error('not an object')
      return plain as Json
    } catch {
      throw new SgccError('network', 'bad-envelope', '无法解密国网的响应')
    }
  }

  /** 密码只以 MD5 的形式传入，协议本身也只需要 MD5。 */
  async login(passwordMd5: string, sms?: { code: string; codeKey: string }): Promise<{ session: Session; accounts: Account[] }> {
    const params = buildLoginParams(this.options.phone, passwordMd5, this.now(), sms)
    const response = await this.post(PATH_LOGIN, params, null, params)
    let data: Json
    try {
      data = unwrap(response)
    } catch (error) {
      if (error instanceof SgccError && (error.kind === 'device' || error.kind === 'risk')) throw error
      // 登录接口上的其他任何拒绝都按账号问题处理，后台不会再自动重试。
      if (error instanceof SgccError) throw new SgccError('credentials', error.code, error.message)
      throw error
    }
    const biz: Json = typeof data.bizrt === 'object' && data.bizrt !== null ? data.bizrt : {}
    if (!biz.token) throw new SgccError('credentials', 'no-token', '登录没有返回凭证')
    const userInfo: Json = Array.isArray(biz.userInfo)
      ? biz.userInfo.find((item: unknown) => typeof item === 'object' && item !== null) ?? {}
      : biz.userInfo ?? {}
    const lifetime = Number(biz.tokenExpireTime) || DEFAULT_TOKEN_LIFETIME_S
    return {
      session: {
        token: String(biz.token),
        userId: String(userInfo.userId || biz.userId || '0'),
        province: String(userInfo.addressProvince ?? ''),
        expiresAt: this.now() + Math.max(300, lifetime) * 1000,
      },
      accounts: parseAccounts(userInfo),
    }
  }

  /** 发送新设备验证短信，返回一次性的 codeKey。只能由用户在界面上明确触发。 */
  async sendDeviceSms(): Promise<string> {
    const payload = {
      uscInfo: { tenant: 'state_grid', member: '2202', devciceId: '000000', devciceName: DEVICE_MODEL, devciceIp: '127.0.0.1' },
      quInfo: { voiceCodeFlag: false, account: this.options.phone, sendType: 0, businessType: 'logindevice' },
    }
    const data = unwrap(await this.post(PATH_SMS, payload, null))
    const codeKey = data.bizrt?.codeKey
    if (!codeKey) throw new SgccError('business', 'no-code-key', '验证码发送失败')
    return String(codeKey)
  }

  async dailyUsage(session: Session, account: Account, startDay: string, endDay: string): Promise<{ readings: DailyUsage[]; totalKwh: number | null }> {
    return parseDaily(await this.dailyRaw(session, account, startDay, endDay))
  }

  /** 未解析的响应，“诊断”按钮用它看国网实际返回了什么。 */
  async dailyRaw(session: Session, account: Account, startDay: string, endDay: string): Promise<Json> {
    const payload = {
      serviceCode: 'BCP_000026',
      source: 'app',
      target: account.provinceCode,
      data: {
        acctId: 'acctid01',
        channelCode: 'SGAPP',
        consNo: account.consNoSrc,
        consNosrc: account.consNoSrc,
        endTime: endDay,
        consType: accountConsType(account),
        funcCode: 'ALIPAY_01',
        orgNo: account.orgNo,
        proCode: account.provinceCode,
        promotCode: '1',
        promotType: '1',
        serialNo: '',
        srvCode: '',
        startTime: startDay,
        userName: 'acctid01',
      },
    }
    return unwrapBusiness(await this.post(PATH_DAILY, payload, session), '每日用电查询')
  }

  async monthlyBills(session: Session, account: Account, year: number): Promise<YearlyBilling> {
    const payload = {
      serviceCode: 'BCP_000026',
      source: 'app',
      target: account.provinceCode,
      data: { year, consNo: account.consNoSrc, provinceCode: account.provinceCode, startYm: `${year}01`, endYm: `${year}12`, funcCode: 'ALIPAY_01' },
    }
    return parseYearlyBilling(unwrapBusiness(await this.post(PATH_MONTHLY, payload, session), '月度账单查询'))
  }

  async balance(session: Session, account: Account): Promise<Balance | null> {
    const payload = {
      serviceCode: '0101143',
      source: 'app',
      target: account.provinceCode,
      data: {
        srvCode: '',
        serialNo: '',
        channelCode: '0902',
        funcCode: 'A1007200',
        acctId: session.userId,
        userName: 'acctid01',
        promotType: '1',
        promotCode: '1',
        userAccountId: session.userId,
        list: [{ consNoSrc: account.consNoSrc, proCode: account.provinceCode, sceneType: account.elecType, consNo: account.consNo, orgNo: account.orgNo }],
      },
    }
    return parseBalance(unwrapBusiness(await this.post(PATH_BALANCE, payload, session), '余额查询'))
  }
}
