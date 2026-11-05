/**
 * 打开脚本后的第一页：余额、最近 30 天用电、月度账单。
 * 打开时只读已保存的数据，不联网；用户点“立即刷新”才查国网。登录和设置都在设置页。
 */
import { BarChart, Button, Chart, HStack, LabeledContent, List, Navigation, NavigationStack, Picker, RuleLineForValueChart, Section, Text, useState, VStack, Widget } from 'scripting'
import { createService, needsManualLogin, type LoginState } from '../lib/service'
import { scriptingTransport } from '../lib/transport'
import type { Account, Settings, Snapshot } from '../lib/types'
import { loadSettings, vault } from '../lib/vault'
import { accountDisplayName, buildDetailView, PLACEHOLDER, type BillView, type DetailView } from '../lib/view-model'
import { describeError, loadInitialState, maskTail, SettingsPage } from './settings'
import { ACCENT, ACCENT_SOFT, kwhText, SECONDARY, TierBar, toneColor, URGENT_TEXT } from './widget-views'

const service = createService(scriptingTransport)

export type DetailState = { login: LoginState; settings: Settings; account: Account | null; snapshot: Snapshot | null }

/** 在组件外读取一次，原因见 settings.tsx 的 loadInitialState。 */
export function loadDetailState(preferredAccountId?: string | null): DetailState {
  const login = service.state()
  const settings = loadSettings()
  const account = login.accounts.find(a => a.id === (preferredAccountId ?? settings.accountId)) ?? login.accounts[0] ?? null
  return { login, settings, account, snapshot: account ? vault.snapshot(account.id) : null }
}

/** 取手机时区的当天零点。用 UTC 零点的话，时区在 UTC 以西的手机上柱子会错一天。 */
function localDate(isoDay: string): Date {
  const [year, month, day] = isoDay.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function Overview({ view }: { view: DetailView }) {
  const { bill } = view
  return (
    <VStack alignment="leading" spacing={2}>
      <Text font="subheadline" foregroundStyle={SECONDARY}>
        {bill.headline.label}
      </Text>
      <HStack alignment="firstTextBaseline" spacing={3}>
        <Text font={40} fontWeight="semibold" fontDesign="rounded" lineLimit={1} minScaleFactor={0.6} foregroundStyle={toneColor(bill.headline.tone)}>
          {bill.headline.amount}
        </Text>
        {bill.headline.amount === PLACEHOLDER ? null : (
          <Text font="subheadline" foregroundStyle={SECONDARY}>
            元
          </Text>
        )}
      </HStack>
      <Text font="caption" foregroundStyle={SECONDARY} lineLimit={1}>
        {`${bill.title} · 更新 ${bill.updated}`}
      </Text>
    </VStack>
  )
}

function TierSummary({ view, tier }: { view: DetailView; tier: NonNullable<BillView['tier']> }) {
  return (
    <VStack alignment="leading" spacing={6}>
      <TierBar view={view.bill} />
      <HStack spacing={4}>
        <Text font="caption" foregroundStyle={SECONDARY}>
          {tier.label}
        </Text>
        <Text font="caption" fontWeight={tier.urgent ? 'semibold' : 'regular'} foregroundStyle={tier.urgent ? URGENT_TEXT : SECONDARY}>
          {tier.hint}
        </Text>
      </HStack>
    </VStack>
  )
}

function DailyChart({ view }: { view: DetailView }) {
  const { daily, dailyAverage } = view
  return (
    <Chart frame={{ height: 180 }}>
      <BarChart
        marks={daily.map((day, index) => ({
          label: localDate(day.day),
          // 不写 unit 的话，日期轴上的柱子宽度会回落成固定值。
          unit: 'day',
          value: day.kwh,
          cornerRadius: 2,
          foregroundStyle: index === daily.length - 1 ? ACCENT : ACCENT_SOFT,
        }))}
      />
      {dailyAverage ? <RuleLineForValueChart marks={[{ value: dailyAverage.kwh, foregroundStyle: SECONDARY, lineStyle: { lineWidth: 1, dash: [3, 3] } }]} /> : null}
    </Chart>
  )
}

function MonthlyChart({ view }: { view: DetailView }) {
  const { months } = view
  return (
    <Chart frame={{ height: 160 }}>
      <BarChart
        marks={months.map((month, index) => ({
          label: month.label,
          value: month.kwh,
          cornerRadius: 2,
          foregroundStyle: index === months.length - 1 ? ACCENT : ACCENT_SOFT,
        }))}
      />
    </Chart>
  )
}

export function DetailPage({ initial }: { initial: DetailState }) {
  const dismiss = Navigation.useDismiss()
  const [state, setState] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const { login, settings, account, snapshot } = state
  const view = account && snapshot ? buildDetailView(snapshot, account, settings) : null
  const loginExpired = needsManualLogin(login)
  const canQuery = login.signedIn && !login.block && !loginExpired && !!account

  /** 登录、换户号、改阶梯都在设置页，回来后要重新读一遍。 */
  const openSettings = async () => {
    await Navigation.present(<SettingsPage initial={loadInitialState()} />)
    setMessage('')
    setState(loadDetailState(account?.id))
  }

  const selectAccount = (id: string) => {
    setMessage('')
    setState(loadDetailState(id))
  }

  const refresh = async () => {
    if (busy || !account) return
    setBusy(true)
    setMessage('')
    try {
      await service.refreshNow(account.id, { includeHistory: true })
      setMessage('已更新。')
      Widget.reloadAll()
    } catch (error) {
      setMessage(describeError(error))
    } finally {
      setState(loadDetailState(account.id))
      setBusy(false)
    }
  }

  const toolbar = {
    cancellationAction: <Button title="完成" action={dismiss} />,
    topBarTrailing: <Button title="设置" systemImage="gearshape" action={openSettings} disabled={busy} />,
  }

  if (!login.signedIn) {
    return (
      <NavigationStack>
        <List navigationTitle="国网电费" navigationBarTitleDisplayMode="inline" toolbar={toolbar}>
          <Section footer={<Text>只在这台手机上直连国网，不经过其他服务器。</Text>}>
            <Text>还没有登录。登录后可以在这里看余额、每日用电和月度账单。</Text>
            <Button title="去登录" action={openSettings} />
          </Section>
        </List>
      </NavigationStack>
    )
  }

  return (
    <NavigationStack>
      <List navigationTitle="国网电费" navigationBarTitleDisplayMode="inline" toolbar={toolbar}>
        <Section>
          {login.accounts.length > 1 && account ? (
            <Picker title="户号" value={account.id} onChanged={selectAccount} pickerStyle="menu">
              {login.accounts.map(item => (
                <Text key={item.id} tag={item.id}>
                  {`${accountDisplayName(item)} ${maskTail(item.consNoSrc)}`}
                </Text>
              ))}
            </Picker>
          ) : null}
          {login.block ? <Text foregroundStyle="systemOrange">{`已暂停自动更新：${login.block.message}。处理好之前小组件不会再联网。`}</Text> : null}
          {loginExpired && !login.block ? <Text foregroundStyle="systemOrange">登录已过期。没有保存密码，需要再登录一次，登录前小组件不会联网。</Text> : null}
          {login.block || loginExpired ? <Button title="去设置处理" action={openSettings} disabled={busy} /> : null}
          {view ? <Overview view={view} /> : null}
          {view ? <LabeledContent title="本月" value={view.bill.monthCost ? `${kwhText(view.bill.monthKwh)} · 约 ${view.bill.monthCost} 元` : kwhText(view.bill.monthKwh)} /> : null}
          {view ? <LabeledContent title="今年累计" value={kwhText(view.bill.yearKwh)} /> : null}
          {view?.bill.tier ? <TierSummary view={view} tier={view.bill.tier} /> : null}
          {!view && account ? <Text>还没有数据，点“立即刷新”查询一次。</Text> : null}
          {!account ? <Text>这个账号没有绑定户号，请先在官方 App 绑定。</Text> : null}
          <Button title={busy ? '处理中…' : '立即刷新'} action={refresh} disabled={busy || !canQuery} />
          {message ? (
            <Text font="caption" foregroundStyle={SECONDARY}>
              {message}
            </Text>
          ) : null}
        </Section>

        {view && view.outlook.length > 0 ? (
          <Section header={<Text>预计和对比</Text>} footer={<Text>本月剩下的日子按最近的日均估算，后面的月份优先按去年同月估算。只是粗估，以官方账单为准。</Text>}>
            {view.outlook.map(row => (
              <LabeledContent key={row.label} title={row.label} value={row.value} />
            ))}
            {view.outlookNote ? (
              <Text font="caption" foregroundStyle={SECONDARY}>
                {view.outlookNote}
              </Text>
            ) : null}
          </Section>
        ) : null}

        {view ? (
          <Section
            header={<Text>{view.daily.length > 0 ? `最近 ${view.daily.length} 天` : '每日用电'}</Text>}
            footer={<Text>{`${view.dailyAverage ? '虚线是日均。' : ''}国网的每日数据通常延迟一两天。`}</Text>}
          >
            {view.daily.length > 0 ? <DailyChart view={view} /> : <Text foregroundStyle={SECONDARY}>暂无每日数据</Text>}
            {view.dailyAverage ? <LabeledContent title="日均" value={view.dailyAverage.text} /> : null}
            {view.dailyPeak ? <LabeledContent title="最高" value={`${view.dailyPeak.label} · ${view.dailyPeak.kwh}`} /> : null}
          </Section>
        ) : null}

        {view ? (
          <Section
            header={<Text>月度账单</Text>}
            footer={<Text>{`${view.monthRows.length < 12 ? '点上面的“立即刷新”会查一次去年的账单，补满 12 个月。' : ''}数据以官方 App 为准。`}</Text>}
          >
            {view.months.length > 0 ? <MonthlyChart view={view} /> : null}
            {view.monthRows.length === 0 ? <Text foregroundStyle={SECONDARY}>暂无账单</Text> : null}
            {view.monthRows.map(row => (
              <LabeledContent key={row.label} title={row.label} value={row.value} />
            ))}
            {view.yearSettled ? <LabeledContent title="今年已出账" value={view.yearSettled} /> : null}
          </Section>
        ) : null}
      </List>
    </NavigationStack>
  )
}
