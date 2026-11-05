/**
 * 小组件界面。小组件只渲染一次，这里不用任何 hooks。
 * 柱状图和阶梯条都用弹性宽度，不依赖“系统有没有内容边距”，官方文档没写明这一点。
 */
import { HStack, Image, ProgressView, RoundedRectangle, Spacer, Text, VStack, Widget } from 'scripting'
import type { WidgetModel } from '../lib/service'
import { PLACEHOLDER, type BillView, type Tone } from '../lib/view-model'

const BACKGROUND = { light: '#FFFFFF', dark: '#1C1C1E' }
export const ACCENT = { light: '#0B8F7E', dark: '#3AD6BF' }
export const ACCENT_SOFT = { light: 'rgba(11,143,126,0.32)', dark: 'rgba(58,214,191,0.34)' }
const TRACK = { light: 'rgba(60,60,67,0.12)', dark: 'rgba(235,235,245,0.16)' }
const TIER_COLORS = ['systemGreen', 'systemOrange', 'systemRed']
/** 小字用的橙色：systemOrange 在白底上对比度不够。 */
export const URGENT_TEXT = { light: '#A85A00', dark: '#FFB340' }
export const SECONDARY = 'secondaryLabel'
const TERTIARY = 'tertiaryLabel'

export const toneColor = (tone: Tone) => (tone === 'danger' ? 'systemRed' : tone === 'warning' ? 'systemOrange' : 'label')

/** 137 → 137 度；缺失时只显示 --，不带单位。 */
export const kwhText = (value: string) => (value === PLACEHOLDER ? PLACEHOLDER : `${value} 度`)

function Title({ text }: { text: string }) {
  return (
    <HStack spacing={4}>
      <Image systemName="bolt.fill" resizable scaleToFit frame={{ width: 10, height: 12 }} foregroundStyle={ACCENT} widgetAccentable />
      <Text font={12} fontWeight="semibold" lineLimit={1}>
        {text}
      </Text>
    </HStack>
  )
}

/** 金额越长字号越小，不靠系统缩放，免得挤到旁边那一栏。 */
export function amountFontSize(amount: string, largest: number): number {
  if (amount.length <= 6) return largest
  return amount.length === 7 ? largest - 4 : largest - 8
}

function Amount({ view, size }: { view: BillView; size: number }) {
  return (
    <VStack alignment="leading" spacing={1}>
      <Text font={11} foregroundStyle={SECONDARY} lineLimit={1}>
        {view.headline.label}
      </Text>
      <HStack alignment="firstTextBaseline" spacing={2}>
        <Text font={amountFontSize(view.headline.amount, size)} fontWeight="semibold" fontDesign="rounded" lineLimit={1} minScaleFactor={0.6} foregroundStyle={toneColor(view.headline.tone)} widgetAccentable>
          {view.headline.amount}
        </Text>
        {view.headline.amount === PLACEHOLDER ? null : (
          <Text font={11} foregroundStyle={SECONDARY}>
            元
          </Text>
        )}
      </HStack>
    </VStack>
  )
}

function Footer({ view }: { view: BillView }) {
  return view.notice ? (
    <Text font={10} foregroundStyle="systemOrange" lineLimit={1} minScaleFactor={0.8}>
      {view.notice}
    </Text>
  ) : (
    <Text font={10} foregroundStyle={SECONDARY} lineLimit={1}>
      {`更新 ${view.updated}`}
    </Text>
  )
}

/**
 * 图表固定 chartSlots 格，HStack 把可用宽度平分。
 * 读数不够时前面补细线占位，否则只有几天数据时柱子会被撑成粗块。
 */
function Bars({ view, height }: { view: BillView; height: number }) {
  const { bars, chartSlots } = view
  if (bars.length === 0) {
    return (
      <Text font={11} foregroundStyle={TERTIARY} frame={{ maxWidth: 'infinity', minHeight: height, maxHeight: height, alignment: 'leading' }}>
        暂无每日数据
      </Text>
    )
  }
  return (
    <HStack alignment="bottom" spacing={chartSlots > 10 ? 2 : 3} frame={{ maxWidth: 'infinity', minHeight: height, maxHeight: height, alignment: 'bottomLeading' }}>
      {Array.from({ length: Math.max(0, chartSlots - bars.length) }, (_, index) => (
        <RoundedRectangle key={`empty-${index}`} fill={TRACK} cornerRadius={1} frame={{ maxWidth: 'infinity', minHeight: 2, maxHeight: 2 }} />
      ))}
      {bars.map((bar, index) => {
        const isLatest = index === bars.length - 1
        const barHeight = Math.max(2, bar.ratio * height)
        return (
          <RoundedRectangle
            key={bar.day}
            fill={isLatest ? ACCENT : ACCENT_SOFT}
            cornerRadius={2}
            frame={{ maxWidth: 'infinity', minHeight: barHeight, maxHeight: barHeight }}
            widgetAccentable={isLatest}
          />
        )
      })}
    </HStack>
  )
}

/** 图表上方：本月用了多少、大概多少钱。 */
function MonthLine({ view }: { view: BillView }) {
  return (
    <HStack spacing={4} padding={{ bottom: 4 }}>
      <Text font={11} fontWeight="semibold" lineLimit={1} minScaleFactor={0.8}>
        {`本月 ${kwhText(view.monthKwh)}`}
      </Text>
      {view.monthCost ? (
        <Text font={11} foregroundStyle={SECONDARY} lineLimit={1} minScaleFactor={0.8}>
          {`· 约 ${view.monthCost} 元`}
        </Text>
      ) : null}
    </HStack>
  )
}

/** 图表下方：起始日期、日均、最新一天的读数。柱子本身没有刻度，靠这一行才看得出跨度和高低。 */
function ChartAxis({ view }: { view: BillView }) {
  const { axis, latest } = view
  if (!axis || !latest) {
    return (
      <Text font={10} foregroundStyle={SECONDARY} lineLimit={1} minScaleFactor={0.8} padding={{ top: 2 }}>
        每日数据通常延迟一两天
      </Text>
    )
  }
  return (
    <HStack spacing={4} padding={{ top: 2 }} frame={{ maxWidth: 'infinity' }}>
      <Text font={10} foregroundStyle={SECONDARY} lineLimit={1}>
        {axis.start}
      </Text>
      <Spacer />
      {axis.average ? (
        <Text font={10} foregroundStyle={SECONDARY} lineLimit={1} minScaleFactor={0.8}>
          {`日均 ${axis.average} 度`}
        </Text>
      ) : null}
      <Spacer />
      <Text font={10} foregroundStyle={SECONDARY} lineLimit={1} minScaleFactor={0.8}>
        {`${latest.label} ${latest.kwh} 度`}
      </Text>
    </HStack>
  )
}

function lastBillLine({ lastBill }: BillView): string {
  if (!lastBill) return `上期账单 ${PLACEHOLDER}`
  return lastBill.yuan === PLACEHOLDER ? `${lastBill.label} ${PLACEHOLDER}` : `${lastBill.label} ${lastBill.yuan} 元`
}

/** 三段等宽，每段表示这一档用了多少。 */
export function TierBar({ view }: { view: BillView }) {
  if (!view.tier) return null
  return (
    <HStack spacing={3} frame={{ maxWidth: 'infinity' }}>
      {view.tier.segments.map((ratio, index) => (
        <ProgressView key={index} value={ratio} total={1} progressViewStyle="linear" tint={TIER_COLORS[index]} />
      ))}
    </HStack>
  )
}

function SmallView({ view }: { view: BillView }) {
  return (
    <VStack alignment="leading" spacing={0} padding={{ horizontal: 14, vertical: 13 }} frame={{ maxWidth: 'infinity', maxHeight: 'infinity', alignment: 'topLeading' }} widgetBackground={BACKGROUND}>
      <Title text={view.title} />
      <Spacer />
      <Amount view={view} size={26} />
      <Spacer />
      <Text font={11} foregroundStyle={SECONDARY} lineLimit={1} minScaleFactor={0.8} padding={{ bottom: 3 }}>
        {view.monthCost ? `本月 ${kwhText(view.monthKwh)} · 约 ${view.monthCost} 元` : `本月 ${kwhText(view.monthKwh)}`}
      </Text>
      <Bars view={view} height={view.tier ? 16 : 22} />
      {view.tier ? (
        <VStack padding={{ top: 4 }} frame={{ maxWidth: 'infinity' }}>
          <TierBar view={view} />
        </VStack>
      ) : null}
      <VStack padding={{ top: 5 }}>
        <Footer view={view} />
      </VStack>
    </VStack>
  )
}

/** 最下面一行：今年累计、当前档位、离下一档还有多远。档位设置不对时只显示累计。 */
function TierRow({ view }: { view: BillView }) {
  const year = `今年 ${kwhText(view.yearKwh)}`
  if (!view.tier) {
    return (
      <Text font={10} foregroundStyle={SECONDARY} lineLimit={1} minScaleFactor={0.8}>
        {year}
      </Text>
    )
  }
  return (
    <VStack alignment="leading" spacing={3} frame={{ maxWidth: 'infinity' }}>
      <TierBar view={view} />
      <HStack spacing={4} frame={{ maxWidth: 'infinity' }}>
        <Text font={10} foregroundStyle={SECONDARY} lineLimit={1} minScaleFactor={0.8}>
          {`${year} · ${view.tier.label}`}
        </Text>
        <Spacer />
        <Text font={10} fontWeight={view.tier.urgent ? 'semibold' : 'regular'} foregroundStyle={view.tier.urgent ? URGENT_TEXT : SECONDARY} lineLimit={1} minScaleFactor={0.8}>
          {view.tier.hint}
        </Text>
      </HStack>
    </VStack>
  )
}

function MediumView({ view }: { view: BillView }) {
  const { width, height } = Widget.displaySize
  // 这一栏的 frame 要写 alignment：frame 默认居中，内容比这一栏窄时会往右缩进。
  const leftWidth = Math.round((width - 32) * 0.38)
  // 不同机型的中号高度从 141 到 170 不等，其他元素高度固定，由柱子来伸缩。
  const chartHeight = Math.max(28, Math.min(52, height - 110))
  return (
    <VStack alignment="leading" spacing={0} padding={{ horizontal: 16, vertical: 13 }} frame={{ maxWidth: 'infinity', maxHeight: 'infinity', alignment: 'topLeading' }} widgetBackground={BACKGROUND}>
      <HStack spacing={6} frame={{ maxWidth: 'infinity' }}>
        <Title text={view.title} />
        <Spacer />
        <Footer view={view} />
      </HStack>
      <Spacer />
      <HStack spacing={14} frame={{ maxWidth: 'infinity' }}>
        <VStack alignment="leading" spacing={3} frame={{ width: leftWidth, alignment: 'leading' }}>
          <Amount view={view} size={28} />
          <Text font={10} foregroundStyle={SECONDARY} lineLimit={1} minScaleFactor={0.8}>
            {lastBillLine(view)}
          </Text>
        </VStack>
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: 'infinity', alignment: 'leading' }}>
          <MonthLine view={view} />
          <Bars view={view} height={chartHeight} />
          <ChartAxis view={view} />
        </VStack>
      </HStack>
      <Spacer />
      <TierRow view={view} />
    </VStack>
  )
}

function Message({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return (
    <VStack spacing={6} padding={{ horizontal: 14, vertical: 12 }} frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }} widgetBackground={BACKGROUND}>
      <Image systemName={icon} resizable scaleToFit frame={{ width: 26, height: 26 }} foregroundStyle={ACCENT} widgetAccentable />
      <Text font={13} fontWeight="semibold" lineLimit={1}>
        {title}
      </Text>
      <Text font={11} foregroundStyle={SECONDARY} multilineTextAlignment="center" lineLimit={3} minScaleFactor={0.8}>
        {detail}
      </Text>
    </VStack>
  )
}

export function WidgetRoot({ model }: { model: WidgetModel }) {
  if (model.state === 'signedOut') return <Message icon="person.crop.circle" title="还没有登录" detail="打开脚本，登录网上国网账号" />
  if (model.state === 'error') return <Message icon="exclamationmark.triangle" title="暂时没有数据" detail={model.message} />
  if (Widget.family === 'systemSmall') return <SmallView view={model.view} />
  if (Widget.family === 'systemMedium') return <MediumView view={model.view} />
  return <Message icon="rectangle.compress.vertical" title="不支持这个尺寸" detail="目前只提供小号和中号" />
}
