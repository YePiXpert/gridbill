/** 脚本主界面：登录、选户号、显示设置、手动刷新。 */
import { Button, LabeledContent, List, Navigation, NavigationStack, Picker, Script, SecureField, Section, Text, TextField, useState, Widget } from 'scripting'
import { chinaTime, SgccError } from '../lib/protocol/client'
import { createService, type LoginState } from '../lib/service'
import { scriptingTransport } from '../lib/transport'
import { DEFAULT_SETTINGS, type Settings } from '../lib/types'
import { loadSettings, saveSettings, vault } from '../lib/vault'
import { accountDisplayName, formatKwh } from '../lib/view-model'

const service = createService(scriptingTransport)
const SMS_COOLDOWN_MS = 60 * 1000

type LoginMode = 'password' | 'code'

export function describeError(error: unknown): string {
  if (error instanceof SgccError) {
    switch (error.kind) {
      case 'network':
        return `${error.message}，请检查网络后重试。`
      case 'device':
        return '国网要求验证新设备。填好密码后点“发送验证码”，收到短信后填入再登录。'
      case 'risk':
        return `国网的安全校验拦下了这次请求${/^RK/.test(error.code) ? `（${error.code}）` : ''}。国网的提示常写成“网络连接超时，请重试”，但多半不是网络问题，不要反复重试。建议先确认官方 App 能正常使用，过几个小时再试一次。短信不一定能解决。`
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

type PriceKey = 'price1' | 'price2' | 'price3'

const priceTexts = (settings: Settings): Record<PriceKey, string> => ({
  price1: String(settings.price1),
  price2: String(settings.price2),
  price3: String(settings.price3),
})

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
  // 单价要能打出“0.”这样的中间状态，所以输入框绑定文字，不绑定解析后的数字。
  const [priceText, setPriceText] = useState(priceTexts(initial.settings))
  const [fetchedAt, setFetchedAt] = useState(initial.fetchedAt)
  const [phone, setPhone] = useState(initial.login.phone)
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<LoginMode>(initial.login.signedIn && !initial.login.canAutoLogin ? 'code' : 'password')
  const [needsSms, setNeedsSms] = useState(false)
  const [codeKey, setCodeKey] = useState('')
  const [code, setCode] = useState('')
  const [smsSentAt, setSmsSentAt] = useState(0)
  const [wantsRelogin, setWantsRelogin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [report, setReport] = useState('')

  const selectedAccount = login.accounts.find(a => a.id === settings.accountId) ?? login.accounts[0] ?? null
  // 没有保存密码时登录到期不能自动续，要用户自己再登录一次。
  const needsManualLogin = login.signedIn && !login.canAutoLogin && !login.sessionExpiresAt
  const showForm = !login.signedIn || !!login.block || wantsRelogin || needsManualLogin
  const canQuery = login.signedIn && !login.block && !needsManualLogin
  const usesCode = mode === 'code' || needsSms
  const canSubmit = !!phone.trim() && (mode === 'code' ? !!codeKey && !!code.trim() : !!password)

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
      if (error instanceof SgccError && error.kind === 'device') {
        setNeedsSms(true)
        // 新设备验证只能配合密码登录，手上的验证码也是另一种类型的，不能接着用。
        if (mode === 'code') {
          setMode('password')
          setCode('')
          setCodeKey('')
        }
      }
      setLogin(service.state())
      setMessage(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  const switchMode = (next: LoginMode) => {
    if (next === mode) return
    setMode(next)
    setNeedsSms(false)
    setCode('')
    setCodeKey('')
    setMessage('')
  }

  /** 验证码是发给某个手机号的，改了号码就不能再用。 */
  const changePhone = (text: string) => {
    setPhone(text)
    setCode('')
    setCodeKey('')
  }

  const signIn = () =>
    guarded(async () => {
      const typed = code.trim()
      if (usesCode && (!codeKey || !typed)) {
        setMessage('请先发送并填写短信验证码。')
        return
      }
      const next =
        mode === 'code'
          ? await service.signInWithCode(phone.trim(), typed, codeKey)
          : await service.signIn(phone.trim(), password, needsSms ? { code: typed, codeKey } : undefined)
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

  /** 登录还有效时重新登录没有好处：短时间内多次登录，真机上被国网的安全校验拦下过。 */
  const startRelogin = async () => {
    if (login.sessionExpiresAt) {
      const confirmed = await Dialog.confirm({
        title: '确定要重新登录吗？',
        message: `当前登录还有效，${login.canAutoLogin ? '到期后会自动续，' : ''}通常不需要重新登录。短时间内多次登录可能被国网的安全校验拦下。`,
        cancelLabel: '取消',
        confirmLabel: '继续',
      })
      if (!confirmed) return
    }
    setWantsRelogin(true)
  }

  const cancelRelogin = () => {
    setWantsRelogin(false)
    setPhone(login.phone)
    setPassword('')
    setCode('')
    setCodeKey('')
    setNeedsSms(false)
    setMessage('')
  }

  const sendCode = () =>
    guarded(async () => {
      const wait = smsSentAt + SMS_COOLDOWN_MS - Date.now()
      if (wait > 0) {
        setMessage(`请 ${Math.ceil(wait / 1000)} 秒后再发送。`)
        return
      }
      setCodeKey(await (mode === 'code' ? service.requestLoginCode(phone.trim()) : service.requestVerificationCode(phone.trim())))
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

  const diagnose = () =>
    guarded(async () => {
      setReport('')
      setReport(await service.diagnoseDaily(selectedAccount?.id))
      setLogin(service.state())
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
    const defaults = loadSettings()
    setSettings(defaults)
    setPriceText(priceTexts(defaults))
    setPhone('')
    setPassword('')
    setMode('password')
    setCode('')
    setCodeKey('')
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

  const changePrice = (key: PriceKey, text: string) => {
    setPriceText({ ...priceText, [key]: text })
    const price = parseFloat(text)
    update({ [key]: Number.isFinite(price) && price > 0 ? price : 0 })
  }

  return (
    <NavigationStack>
      <List navigationTitle="国网电费" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="完成" action={dismiss} /> }}>
        <Section
          header={<Text>账号</Text>}
          footer={<Text>只在这台手机上直连国网，不经过其他服务器。不保存明文密码；用来自动续登录的密码 MD5 存在本脚本的钥匙串里，不同步 iCloud。用密码登录时，到期后会自动续，只有国网要求短信验证或密码变了才需要你处理。只用验证码登录时不保存密码，到期后要再登录一次。</Text>}
        >
          {login.signedIn ? <LabeledContent title="账号" value={maskTail(login.phone)} /> : null}
          {login.signedIn && login.sessionExpiresAt ? <LabeledContent title="本次登录到期" value={formatTime(login.sessionExpiresAt)} /> : null}
          {login.block ? <Text foregroundStyle="systemOrange">已暂停自动更新：{login.block.message}。处理好之前小组件不会再联网。</Text> : null}
          {needsManualLogin && !login.block ? <Text foregroundStyle="systemOrange">登录已过期。没有保存密码，需要再登录一次，登录前小组件不会联网。</Text> : null}
          {showForm ? (
            <Picker title="登录方式" value={mode} onChanged={switchMode} pickerStyle="segmented" disabled={busy}>
              <Text tag="password">密码登录</Text>
              <Text tag="code">验证码登录</Text>
            </Picker>
          ) : null}
          {showForm ? <Field title="手机号" prompt="网上国网登录手机号" value={phone} onChanged={changePhone} keyboardType="phonePad" disabled={busy} /> : null}
          {showForm && mode === 'password' ? (
            <LabeledContent title="密码">
              <SecureField title="密码" prompt="登录密码" value={password} onChanged={setPassword} disabled={busy} multilineTextAlignment="trailing" />
            </LabeledContent>
          ) : null}
          {showForm && usesCode ? <Button title="发送验证码" action={sendCode} disabled={busy || !phone.trim()} /> : null}
          {showForm && usesCode ? <Field title="短信验证码" prompt="6 位数字" value={code} onChanged={setCode} keyboardType="numberPad" textContentType="oneTimeCode" disabled={busy} /> : null}
          {showForm ? <Button title={busy ? '处理中…' : needsSms ? '验证并登录' : '登录'} action={signIn} disabled={busy || !canSubmit} /> : null}
          {wantsRelogin && !login.block ? <Button title="取消" action={cancelRelogin} disabled={busy} /> : null}
          {login.signedIn && !showForm ? <Button title="重新登录" action={startRelogin} /> : null}
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
                  {`${accountDisplayName(account)} ${maskTail(account.consNoSrc)}`}
                </Text>
              ))}
            </Picker>
            {selectedAccount ? (
              <Field
                title="显示名称"
                prompt={accountDisplayName(selectedAccount)}
                value={settings.names[selectedAccount.id] ?? ''}
                onChanged={text => update({ names: { ...settings.names, [selectedAccount.id]: text } })}
              />
            ) : null}
          </Section>
        ) : null}

        <Section header={<Text>阶梯电价</Text>} footer={<Text>默认是北京一户一表、不满 1 千伏的标准。其他地区或申请过多人口调整的家庭，请改成实际标准；清空后恢复默认。今年累计和本月电费都是估算值，以官方账单为准。</Text>}>
          <Field title="第二档起点（度/年）" prompt={String(DEFAULT_SETTINGS.tier2)} value={settings.tier2 > 0 ? String(settings.tier2) : ''} keyboardType="numberPad" onChanged={text => update({ tier2: parseTier(text) })} />
          <Field title="第三档起点（度/年）" prompt={String(DEFAULT_SETTINGS.tier3)} value={settings.tier3 > 0 ? String(settings.tier3) : ''} keyboardType="numberPad" onChanged={text => update({ tier3: parseTier(text) })} />
          <Field title="第一档电价（元/度）" prompt={String(DEFAULT_SETTINGS.price1)} value={priceText.price1} keyboardType="decimalPad" onChanged={text => changePrice('price1', text)} />
          <Field title="第二档电价（元/度）" prompt={String(DEFAULT_SETTINGS.price2)} value={priceText.price2} keyboardType="decimalPad" onChanged={text => changePrice('price2', text)} />
          <Field title="第三档电价（元/度）" prompt={String(DEFAULT_SETTINGS.price3)} value={priceText.price3} keyboardType="decimalPad" onChanged={text => changePrice('price3', text)} />
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

        <Section header={<Text>数据</Text>} footer={<Text>“诊断每日数据”会多查三次国网，只显示条数、日期、读数和字段名，不含账号和户号，可以截图发给别人看。</Text>}>
          {fetchedAt > 0 ? <LabeledContent title="上次更新" value={formatTime(fetchedAt)} /> : null}
          <Button title={busy ? '处理中…' : '立即刷新'} action={refresh} disabled={busy || !canQuery} />
          <Button title="诊断每日数据" action={diagnose} disabled={busy || !canQuery} />
          {report ? <Text font="caption">{report}</Text> : null}
          <LabeledContent title="脚本版本" value={Script.metadata.version ?? '未知'} />
          <LabeledContent title="远程来源" value={Script.metadata.remoteResource?.url ? '已设置' : '未设置'} />
          <Button title="退出并清除全部数据" role="destructive" action={erase} disabled={busy} />
        </Section>
      </List>
    </NavigationStack>
  )
}
