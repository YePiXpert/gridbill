/**
 * 小组件界面。小组件只渲染一次，这里不用任何 hooks。
 * 柱状图和阶梯条都用弹性宽度，不依赖“系统有没有内容边距”，官方文档没写明这一点。
 */
import { HStack, Image, ProgressView, RoundedRectangle, Spacer, Text, VStack, Widget } from 'scripting'
import type { WidgetModel } from '../lib/service'
import { PLACEHOLDER, type BillView, type Tone } from '../lib/view-model'

const BACKGROUND = { light: '#FFFFFF', dark: '#1C1C1E' }
const ACCENT = { light: '#0B8F7E', dark: '#3AD6BF' }
const ACCENT_SOFT = { light: 'rgba(11,143,126,0.32)', dark: 'rgba(58,214,191,0.34)' }
const TRACK = { light: 'rgba(60,60,67,0.12)', dark: 'rgba(235,235,245,0.16)' }
const TIER_COLORS = ['systemGreen', 'systemOrange', 'systemRed']
const SECONDARY = 'secondaryLabel'
const TERTIARY = 'tertiaryLabel'

const toneColor = (tone: Tone) => (tone === 'danger' ? 'systemRed' : tone === 'warning' ? 'systemOrange' : 'label')

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

function Footer({ view, noticeLines }: { view: BillView; noticeLines: number }) {
  return view.notice ? (
    <Text font={10} foregroundStyle="systemOrange" lineLimit={noticeLines} minScaleFactor={0.8}>
      {view.notice}
    </Text>
  ) : (
    <Text font={10} foregroundStyle={TERTIARY} lineLimit={1}>
      {`更新 ${view.updated}`}
    </Text>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <VStack alignment="leading" spacing={1}>
      <Text font={10} foregroundStyle={SECONDARY} lineLimit={1}>
        {label}
      </Text>
      <HStack alignment="firstTextBaseline" spacing={1}>
        <Text font={14} fontWeight="semibold" fontDesign="rounded" lineLimit={1} minScaleFactor={0.7}>
          {value}
        </Text>
        {value === PLACEHOLDER ? null : (
          <Text font={9} foregroundStyle={SECONDARY}>
            {unit}
          </Text>
        )}
      </HStack>
    </VStack>
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

function latestLine({ latest, monthCost }: BillView): string {
  if (!latest) return '每日数据通常延迟一两天'
  return monthCost ? `最新 ${latest.label} ${latest.kwh} 度 · 本月约 ${monthCost} 元` : `最新 ${latest.label} 用电 ${latest.kwh} 度`
}

/** 三段等宽，每段表示这一档用了多少。 */
function TierBar({ view }: { view: BillView }) {
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
        {view.monthCost ? `本月 ${view.monthKwh} 度 · 约 ${view.monthCost} 元` : `本月 ${view.monthKwh} 度`}
      </Text>
      <Bars view={view} height={view.tier ? 16 : 22} />
      {view.tier ? (
        <VStack padding={{ top: 4 }} frame={{ maxWidth: 'infinity' }}>
          <TierBar view={view} />
        </VStack>
      ) : null}
      <VStack padding={{ top: 5 }}>
        <Footer view={view} noticeLines={1} />
      </VStack>
    </VStack>
  )
}

function MediumView({ view }: { view: BillView }) {
  const leftWidth = Math.round((Widget.displaySize.width - 32) * 0.36)
  return (
    <HStack alignment="top" spacing={14} padding={{ horizontal: 16, vertical: 14 }} frame={{ maxWidth: 'infinity', maxHeight: 'infinity', alignment: 'topLeading' }} widgetBackground={BACKGROUND}>
      <VStack alignment="leading" spacing={0} frame={{ width: leftWidth }}>
        <Title text={view.title} />
        <Spacer />
        <Amount view={view} size={28} />
        <Spacer />
        <Footer view={view} noticeLines={2} />
      </VStack>
      <VStack alignment="leading" spacing={0} frame={{ maxWidth: 'infinity' }}>
        <HStack alignment="top" spacing={4} frame={{ maxWidth: 'infinity' }}>
          <Stat label="本月" value={view.monthKwh} unit="度" />
          <Spacer />
          <Stat label={view.lastBill?.label ?? '上期账单'} value={view.lastBill?.yuan ?? PLACEHOLDER} unit="元" />
          <Spacer />
          <Stat label="今年" value={view.yearKwh} unit="度" />
        </HStack>
        <Spacer />
        <Bars view={view} height={view.tier ? 28 : 44} />
        <Text font={10} foregroundStyle={SECONDARY} lineLimit={1} minScaleFactor={0.8} padding={{ top: 3 }}>
          {latestLine(view)}
        </Text>
        {view.tier ? (
          <VStack alignment="leading" spacing={2} padding={{ top: 5 }} frame={{ maxWidth: 'infinity' }}>
            <TierBar view={view} />
            <Text font={10} foregroundStyle={SECONDARY} lineLimit={1} minScaleFactor={0.8}>
              {view.tier.text}
            </Text>
          </VStack>
        ) : null}
      </VStack>
    </HStack>
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
