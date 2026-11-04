/**
 * 本地存储。
 *
 * 钥匙串（Keychain）：账号、密码 MD5、登录会话、设备身份、用电数据、登录闸门。
 *   官方文档：每个脚本有独立的钥匙串范围，其他脚本不能直接读取；
 *   默认 first_unlock_this_device，不同步 iCloud、不迁移到新设备；脚本删除时一并清除。
 *   用电数据也放这里：写入是同步的（小组件调用 present 后上下文立即销毁），也不进共享目录。
 * Storage：只放显示设置。官方文档：默认是脚本私有域。
 *
 * 明文密码不落地，只保存协议实际需要的 MD5。
 */
import type { Account, Session, Settings, Snapshot } from './types'
import { DEFAULT_SETTINGS } from './types'
import type { DeviceState } from './protocol/turing'

export type Credentials = { phone: string; passwordMd5: string }

/** 为什么后台必须停下来等用户处理。 */
export type Block = { kind: 'credentials' | 'device' | 'risk'; message: string; at: number }
export type Gate = { block: Block | null; lastAutoLoginAt: number }

function read<T>(key: string): T | null {
  try {
    const raw = Keychain.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  if (!Keychain.set(key, JSON.stringify(value))) throw new Error('无法写入钥匙串')
}

export const vault = {
  credentials: () => read<Credentials>('credentials'),
  saveCredentials: (value: Credentials) => write('credentials', value),

  session: () => read<Session>('session'),
  saveSession: (value: Session) => write('session', value),
  clearSession: () => void Keychain.remove('session'),

  accounts: () => read<Account[]>('accounts') ?? [],
  saveAccounts: (value: Account[]) => write('accounts', value),

  device: (phone: string) => read<DeviceState>(`device.${phone}`),
  saveDevice: (phone: string, value: DeviceState) => write(`device.${phone}`, value),

  gate: (): Gate => read<Gate>('gate') ?? { block: null, lastAutoLoginAt: 0 },
  saveGate: (value: Gate) => write('gate', value),

  snapshot: (accountId: string) => read<Snapshot>(`snapshot.${accountId}`),
  saveSnapshot: (value: Snapshot) => write(`snapshot.${value.accountId}`, value),
  removeSnapshot: (accountId: string) => void Keychain.remove(`snapshot.${accountId}`),

  lastAttempt: (accountId: string) => read<number>(`attempt.${accountId}`) ?? 0,
  saveLastAttempt: (accountId: string, at: number) => write(`attempt.${accountId}`, at),

  /** 清除当前脚本的全部数据，官方文档保证不影响其他脚本。 */
  eraseAll: () => {
    if (!Keychain.clear()) throw new Error('钥匙串清除失败，请重试')
    Storage.clear()
  },
}

export function loadSettings(): Settings {
  const stored = Storage.get<Partial<Settings>>('settings') ?? {}
  const positive = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    accountId: typeof stored.accountId === 'string' ? stored.accountId : DEFAULT_SETTINGS.accountId,
    names: typeof stored.names === 'object' && stored.names !== null ? stored.names : {},
    // 没填或清空都用默认值（旧版本把没填的存成 0）。
    tier2: positive(stored.tier2) || DEFAULT_SETTINGS.tier2,
    tier3: positive(stored.tier3) || DEFAULT_SETTINGS.tier3,
    price1: positive(stored.price1) || DEFAULT_SETTINGS.price1,
    price2: positive(stored.price2) || DEFAULT_SETTINGS.price2,
    price3: positive(stored.price3) || DEFAULT_SETTINGS.price3,
    chartDays: positive(stored.chartDays) || DEFAULT_SETTINGS.chartDays,
    refreshHours: positive(stored.refreshHours) || DEFAULT_SETTINGS.refreshHours,
  }
}

export function saveSettings(settings: Settings): void {
  if (!Storage.set('settings', settings)) throw new Error('无法保存设置')
}
