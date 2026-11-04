/** 脚本主界面：登录、选户号、显示设置、手动刷新。 */
import { Button, LabeledContent, List, Navigation, NavigationStack, Picker, SecureField, Section, Text, TextField, useState, Widget } from 'scripting'
import { chinaTime, SgccError } from '../lib/protocol/client'
import { createService, type LoginState } from '../lib/service'
import { scriptingTransport } from '../lib/transport'
import type { Settings } from '../lib/types'
import { loadSettings, saveSettings, vault } from '../lib/vault'
import { formatKwh } from '../lib/view-model'

const service = createService(scriptingTransport)
const SMS_COOLDOWN_MS = 60 * 1000

function describeError(error: unknown): string {
  if (error instanceof SgccError) {
    switch (error.kind) {
      case 'network':
        return `${error.message}，请检查网络后重试。`
      case 'device':
        return '国网要求验证新设备。点“发送验证码”，收到短信后填入再登录。'
      case 'risk':
        return '国网安全校验未通过（RK008）。普通短信不一定能解决，建议先在官方 App 确认账号状态，过一段时间再试。'
      default:
        return error.message
    }
  }
  return error instanceof Error ? error.message : String(error)
}

const maskTail = (text: string) => (text.length > 4 ? `****${text.slice(-4)}` : text)

function formatTime(ms: number): string {
  const t = chinaTime(ms)
  return `${t.month}月${t.day}日 ${t.hour}:${t.minute}`
}

function lastFetchedAt(login: LoginState, settings: Settings): number {
  const account = login.accounts.find(a => a.id === settings.accountId) ?? login.accounts[0]
  return account ? vault.snapshot(account.id)?.fetchedAt ?? 0 : 0
}

export type InitialState = { login: LoginState; settings: Settings; fetchedAt: number }

/**
 * 在组件外读取一次。官方示例的注释提到 useState 的惰性初始值会在每次重新渲染时重跑，
 * 放在里面的话每敲一个字都要读一遍钥匙串。
 */
export function loadInitialState(): InitialState {
  const login = service.state()
  const settings = loadSettings()
  return { login, settings, fetchedAt: lastFetchedAt(login, settings) }
}

/** iOS 的列表里输入框不显示 title，有内容时就看不出是什么，所以外面包一层 LabeledContent。 */
function Field({ title, prompt, value, onChanged, disabled, keyboardType, textContentType }: {
  title: string
  prompt?: string
  value: string
  onChanged: (text: string) => void
  disabled?: boolean
  keyboardType?: string
  textContentType?: string
}) {
  return (
    <LabeledContent title={title}>
      <TextField title={title} prompt={prompt} value={value} onChanged={onChanged} disabled={disabled} keyboardType={keyboardType} textContentType={textContentType} multilineTextAlignment="trailing" />
    </LabeledContent>
  )
}

export function SettingsPage({ initial }: { initial: InitialState }) {
  const dismiss = Navigation.useDismiss()
  const [login, setLogin] = useState(initial.login)
  const [settings, setSettings] = useState(initial.settings)
  const [fetchedAt, setFetchedAt] = useState(initial.fetchedAt)
  const [phone, setPhone] = useState(initial.login.phone)
  const [password, setPassword] = useState('')
  const [needsSms, setNeedsSms] = useState(false)
  const [codeKey, setCodeKey] = useState('')
  const [code, setCode] = useState('')
  const [smsSentAt, setSmsSentAt] = useState(0)
  const [wantsRelogin, setWantsRelogin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const selectedAccount = login.accounts.find(a => a.id === settings.accountId) ?? login.accounts[0] ?? null
  const showForm = !login.signedIn || !!login.block || wantsRelogin

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    try {
      saveSettings(next)
    } catch (error) {
      setMessage(describeError(error))
    }
  }

  const guarded = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      await work()
    } catch (error) {
      if (error instanceof SgccError && error.kind === 'device') setNeedsSms(true)
      setLogin(service.state())
      setMessage(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  const signIn = () =>
    guarded(async () => {
      const typed = code.trim()
      if (needsSms && (!codeKey || !typed)) {
        setMessage('请先发送并填写短信验证码。')
        return
      }
      const next = await service.signIn(phone.trim(), password, needsSms ? { code: typed, codeKey } : undefined)
      setLogin(next)
      setPassword('')
      setCode('')
      setCodeKey('')
      setNeedsSms(false)
      setWantsRelogin(false)
      const account = next.accounts.find(a => a.id === settings.accountId) ?? next.accounts[0]
      if (!account) {
        setMessage('登录成功，但这个账号没有绑定户号，请先在官方 App 绑定。')
        return
      }
      if (account.id !== settings.accountId) update({ accountId: account.id })
      // 登录后马上查一次，有问题当场能看到，不用等小组件。
      try {
        const snapshot = await service.refreshNow(account.id)
        setFetchedAt(snapshot.fetchedAt)
        setMessage(`登录成功，共 ${next.accounts.length} 个户号。本月用电 ${formatKwh(snapshot.monthKwh)} 度。`)
      } catch (error) {
        setLogin(service.state())
        setMessage(`登录成功，但查询数据失败：${describeError(error)}`)
      }
      Widget.reloadAll()
    })

  const sendCode = () =>
    guarded(async () => {
      const wait = smsSentAt + SMS_COOLDOWN_MS - Date.now()
      if (wait > 0) {
        setMessage(`请 ${Math.ceil(wait / 1000)} 秒后再发送。`)
        return
      }
      setCodeKey(await service.requestVerificationCode(phone.trim()))
      setSmsSentAt(Date.now())
      setMessage('验证码已发送，请查收短信。')
    })

  const refresh = () =>
    guarded(async () => {
      const snapshot = await service.refreshNow(selectedAccount?.id)
      setFetchedAt(snapshot.fetchedAt)
      setLogin(service.state())
      setMessage('已更新。')
      Widget.reloadAll()
    })

  const erase = async () => {
    const confirmed = await Dialog.confirm({
      title: '退出并清除数据',
      message: '会删除这个脚本保存的账号、密码 MD5、登录状态、设备身份、用电数据和设置。下次登录可能需要短信验证。',
      cancelLabel: '取消',
      confirmLabel: '清除',
    })
    if (!confirmed) return
    try {
      service.eraseAll()
    } catch (error) {
      setMessage(describeError(error))
      return
    }
    setLogin(service.state())
    setSettings(loadSettings())
    setPhone('')
    setPassword('')
    setNeedsSms(false)
    setFetchedAt(0)
    setMessage('已清除。')
    Widget.reloadAll()
  }

  const preview = async (family: 'systemSmall' | 'systemMedium') => {
    try {
      await Widget.preview({
        family,
        // 官方要求参数值是能被 JSON 解析的字符串。
        parameters: { options: { 演示数据: JSON.stringify('demo'), 真实数据: JSON.stringify('') }, default: '演示数据' },
      })
    } catch (error) {
      setMessage(`预览失败：${describeError(error)}`)
    }
  }

  const parseTier = (text: string) => {
    const value = parseInt(text, 10)
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  return (
    <NavigationStack>
      <List navigationTitle="国网电费" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="完成" action={dismiss} /> }}>
        <Section
          header={<Text>账号</Text>}
          footer={<Text>只在这台手机上直连国网，不经过其他服务器。不保存明文密码；用来自动续登录的密码 MD5 存在本脚本的钥匙串里，不同步 iCloud。</Text>}
        >
          {login.signedIn ? <LabeledContent title="账号" value={maskTail(login.phone)} /> : null}
          {login.signedIn && login.sessionExpiresAt ? <LabeledContent title="登录有效期至" value={formatTime(login.sessionExpiresAt)} /> : null}
          {login.block ? <Text foregroundStyle="systemOrange">已暂停自动更新：{login.block.message}。处理好之前小组件不会再联网。</Text> : null}
          {showForm ? <Field title="手机号" prompt="网上国网登录手机号" value={phone} onChanged={setPhone} keyboardType="phonePad" disabled={busy} /> : null}
          {showForm ? (
            <LabeledContent title="密码">
              <SecureField title="密码" prompt="登录密码" value={password} onChanged={setPassword} disabled={busy} multilineTextAlignment="trailing" />
            </LabeledContent>
          ) : null}
          {showForm && needsSms ? <Button title="发送验证码" action={sendCode} disabled={busy || !phone.trim()} /> : null}
          {showForm && needsSms ? <Field title="短信验证码" prompt="6 位数字" value={code} onChanged={setCode} keyboardType="numberPad" textContentType="oneTimeCode" disabled={busy} /> : null}
          {showForm ? <Button title={busy ? '处理中…' : needsSms ? '验证并登录' : '登录'} action={signIn} disabled={busy || !phone.trim() || !password} /> : null}
          {login.signedIn && !showForm ? <Button title="重新登录" action={() => setWantsRelogin(true)} /> : null}
          {message ? (
            <Text font="caption" foregroundStyle="secondaryLabel">
              {message}
            </Text>
          ) : null}
        </Section>

        {login.accounts.length > 0 ? (
          <Section header={<Text>户号</Text>} footer={<Text>小组件参数留空时显示这里选的户号。放多个小组件时，可以在“编辑小组件”的参数里填 1、2、3，或显示名称，或户号尾号。</Text>}>
            <Picker title="默认户号" value={selectedAccount?.id ?? ''} onChanged={(id: string) => update({ accountId: id })} pickerStyle="menu">
              {login.accounts.map(account => (
                <Text key={account.id} tag={account.id}>
                  {`${account.name} ${maskTail(account.consNoSrc)}`}
                </Text>
              ))}
            </Picker>
            {selectedAccount ? (
              <Field
                title="显示名称"
                prompt={selectedAccount.name}
                value={settings.names[selectedAccount.id] ?? ''}
                onChanged={text => update({ names: { ...settings.names, [selectedAccount.id]: text } })}
              />
            ) : null}
          </Section>
        ) : null}

        <Section header={<Text>阶梯电价</Text>} footer={<Text>各地档位不同，请按当地标准填写年度分档用量。留空就不显示阶梯。今年累计是估算值：已结算电量加上结算后的每日用电，以官方账单为准。</Text>}>
          <Field title="第二档起点（度/年）" prompt="例如 2880" value={settings.tier2 > 0 ? String(settings.tier2) : ''} keyboardType="numberPad" onChanged={text => update({ tier2: parseTier(text) })} />
          <Field title="第三档起点（度/年）" prompt="例如 4800" value={settings.tier3 > 0 ? String(settings.tier3) : ''} keyboardType="numberPad" onChanged={text => update({ tier3: parseTier(text) })} />
        </Section>

        <Section header={<Text>小组件</Text>} footer={<Text>国网的每日数据通常延迟一两天，刷新太频繁没有意义，也更容易触发风控。实际刷新时间由 iOS 决定。</Text>}>
          <Picker title="刷新间隔" value={settings.refreshHours} onChanged={(hours: number) => update({ refreshHours: hours })} pickerStyle="menu">
            {[6, 12, 24].map(hours => (
              <Text key={hours} tag={hours}>
                {`${hours} 小时`}
              </Text>
            ))}
          </Picker>
          <Picker title="柱状图天数" value={settings.chartDays} onChanged={(days: number) => update({ chartDays: days })} pickerStyle="menu">
            {[7, 14, 21].map(days => (
              <Text key={days} tag={days}>
                {`${days} 天`}
              </Text>
            ))}
          </Picker>
          <Button title="预览小号" action={() => preview('systemSmall')} />
          <Button title="预览中号" action={() => preview('systemMedium')} />
        </Section>

        <Section header={<Text>数据</Text>}>
          {fetchedAt > 0 ? <LabeledContent title="上次更新" value={formatTime(fetchedAt)} /> : null}
          <Button title={busy ? '处理中…' : '立即刷新'} action={refresh} disabled={busy || !login.signedIn || !!login.block} />
          <Button title="退出并清除全部数据" role="destructive" action={erase} disabled={busy} />
        </Section>
      </List>
    </NavigationStack>
  )
}
