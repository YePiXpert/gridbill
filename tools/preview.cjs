'use strict'
/**
 * 桌面布局预览：把小组件的 TSX 映射成 HTML，方便在电脑上看个大概。
 * 这只是近似（图标是占位符，字体和间距和 iOS 有差别），最终效果以手机为准。
 * 用法：npm run preview，然后用浏览器打开生成的 preview.html。
 */
const fs = require('node:fs')
const path = require('node:path')
const { fake, expand } = require('../tests/support/fake-ui.cjs')

const { WidgetRoot } = require('../.build/GridBill/ui/widget-views')
const { buildBillView, demoSnapshot } = require('../.build/GridBill/lib/view-model')
const { DEFAULT_SETTINGS } = require('../.build/GridBill/lib/types')

const NOW = Date.UTC(2026, 10, 4, 0, 30)
const ACCOUNT = { id: 'a', name: '我家', consNo: '', consNoSrc: '', provinceCode: '', orgNo: '', elecType: '01' }
const next = new Date(NOW)

const KEYWORDS = {
  label: 'var(--label)',
  secondaryLabel: 'var(--secondary)',
  tertiaryLabel: 'var(--tertiary)',
  systemOrange: '#FF9500',
  systemRed: '#FF3B30',
  systemGreen: '#34C759',
}
const ICONS = { 'bolt.fill': '⚡', 'person.crop.circle': '👤', 'exclamationmark.triangle': '⚠', 'rectangle.compress.vertical': '▭' }

const color = (value, dark) => {
  if (value === undefined) return undefined
  if (typeof value === 'object') return dark ? value.dark : value.light
  return KEYWORDS[value] ?? value
}
const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function commonStyle(props, dark, parent) {
  const css = []
  const { frame, padding } = props
  if (frame) {
    if (frame.width !== undefined) css.push(`width:${frame.width}px;flex:none`)
    if (frame.height !== undefined) css.push(`height:${frame.height}px;flex:none`)
    if (frame.minHeight !== undefined) css.push(`min-height:${frame.minHeight}px`)
    if (frame.maxHeight === 'infinity') css.push('height:100%')
    else if (frame.maxHeight !== undefined) css.push(`max-height:${frame.maxHeight}px;height:${frame.maxHeight}px;flex-shrink:0`)
    if (frame.maxWidth === 'infinity') css.push(parent === 'HStack' ? 'flex:1 1 0;min-width:0' : 'width:100%')
  }
  if (padding) {
    const p = { top: padding.top ?? padding.vertical ?? 0, bottom: padding.bottom ?? padding.vertical ?? 0, left: padding.horizontal ?? 0, right: padding.horizontal ?? 0 }
    css.push(`padding:${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`)
  }
  const fg = color(props.foregroundStyle, dark)
  if (fg) css.push(`color:${fg}`)
  return css
}

function render(node, dark, parent) {
  if (typeof node === 'string') return escapeHtml(node)
  const { type, props, children } = node
  const css = commonStyle(props, dark, parent)
  const inner = () => children.map(child => render(child, dark, type)).join('')
  switch (type) {
    case 'VStack': {
      const align = { leading: 'flex-start', trailing: 'flex-end', center: 'center' }[props.alignment ?? 'center']
      css.push('display:flex;flex-direction:column', `align-items:${align}`, `gap:${props.spacing ?? 0}px`, 'box-sizing:border-box;min-width:0')
      if (!props.alignment) css.push('justify-content:center')
      // SwiftUI 里带 Spacer 的 VStack 会撑满父容器给的高度。
      if (children.some(child => child.type === 'Spacer')) css.push('align-self:stretch')
      break
    }
    case 'HStack': {
      const align = { top: 'flex-start', bottom: 'flex-end', center: 'center', firstTextBaseline: 'first baseline' }[props.alignment ?? 'center']
      css.push('display:flex;flex-direction:row', `align-items:${align}`, `gap:${props.spacing ?? 0}px`, 'box-sizing:border-box;min-width:0')
      break
    }
    case 'Spacer':
      return '<div style="flex:1 1 0;min-height:0;min-width:0"></div>'
    case 'Text':
      css.push(`font-size:${typeof props.font === 'number' ? props.font : 14}px`, `font-weight:${{ semibold: 600, medium: 500, bold: 700 }[props.fontWeight] ?? 400}`)
      if (props.fontDesign === 'rounded') css.push('font-family:ui-rounded,"SF Pro Rounded",-apple-system,sans-serif')
      if (props.lineLimit === 1) css.push('white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%')
      if (props.multilineTextAlignment === 'center') css.push('text-align:center')
      if (props.frame?.alignment) css.push('display:flex;align-items:center')
      // SwiftUI 的文字不会被压缩到比一行还矮，这里也不允许，溢出才能被发现。
      css.push('flex-shrink:0')
      return `<span style="${css.join(';')}">${inner()}</span>`
    case 'RoundedRectangle':
      css.push(`background:${color(props.fill, dark)}`, `border-radius:${props.cornerRadius ?? 0}px`)
      return `<div style="${css.join(';')}"></div>`
    case 'ProgressView': {
      const percent = Math.round((props.value / props.total) * 100)
      return `<div style="flex:1 1 0;min-width:0;height:4px;border-radius:2px;overflow:hidden;background:var(--track)"><div style="width:${percent}%;height:100%;border-radius:2px;background:${color(props.tint, dark)}"></div></div>`
    }
    case 'Image':
      css.push(`font-size:${(props.frame?.height ?? 14) * 0.9}px;line-height:1;display:flex;align-items:center;justify-content:center`)
      return `<div style="${css.join(';')}">${ICONS[props.systemName] ?? '●'}</div>`
    default:
      throw new Error(`预览不支持组件 ${type}`)
  }
  return `<div style="${css.join(';')}">${inner()}</div>`
}

function widget(model, family, size, dark) {
  fake.Widget.family = family
  fake.Widget.displaySize = size
  const tree = expand(createElement(WidgetRoot, { model }))
  const background = color(tree.props.widgetBackground, dark)
  return `<div class="widget ${dark ? 'dark' : 'light'}" style="width:${size.width}px;height:${size.height}px;background:${background}">${render(tree, dark, 'root')}</div>`
}

const view = (snapshotPatch = {}, settings = {}, notice = null) =>
  buildBillView({ ...demoSnapshot(NOW), ...snapshotPatch }, ACCOUNT, { ...DEFAULT_SETTINGS, ...settings }, notice)
const ok = v => ({ state: 'ok', view: v, nextRefresh: next })
const TIERS = { tier2: 2880, tier3: 4800 }

const CASES = [
  ['默认（未设置阶梯）', ok(view())],
  ['设置了阶梯', ok(view({}, TIERS))],
  ['第三档、21 天', ok(view({ yearEstimateKwh: 5230 }, { ...TIERS, chartDays: 21 }))],
  ['后付费应交', ok(view({ balance: { isPrepaid: false, balance: null, amountDue: 326.8, overdue: null } }, TIERS))],
  ['欠费', ok(view({ balance: { isPrepaid: false, balance: null, amountDue: 1280.5, overdue: 1280.5 } }))],
  ['余额接口不可用', ok(view({ balance: null }))],
  ['数字很大', ok(view({ balance: { isPrepaid: true, balance: 12345.67, amountDue: null, overdue: null }, monthKwh: 1234, yearEstimateKwh: 12345, lastBill: { month: '2026-10', kwh: 2000, yuan: 1234.56, endDay: null } }, TIERS))],
  ['需要处理（已停止联网）', ok(view({}, TIERS, '安全校验未通过，请打开脚本'))],
  ['没有每日数据', ok(view({ daily: [] }))],
  ['还没有登录', { state: 'signedOut', nextRefresh: next }],
  ['出错', { state: 'error', message: '更新失败，稍后重试', nextRefresh: next }],
]

const SIZES = {
  systemSmall: [{ width: 158, height: 158 }, { width: 148, height: 148 }],
  systemMedium: [{ width: 338, height: 158 }, { width: 321, height: 148 }],
}

let body = ''
for (const [title, model] of CASES) {
  body += `<h2>${escapeHtml(title)}</h2><div class="row">`
  for (const dark of [false, true]) {
    body += widget(model, 'systemSmall', SIZES.systemSmall[0], dark)
    body += widget(model, 'systemMedium', SIZES.systemMedium[0], dark)
  }
  // 最小的屏幕（iPhone SE 尺寸）最容易放不下，每种状态都放一组。
  body += widget(model, 'systemSmall', SIZES.systemSmall[1], false)
  body += widget(model, 'systemMedium', SIZES.systemMedium[1], false)
  body += '</div>'
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>GridBill 布局预览</title><style>
body{margin:0;padding:24px;background:#8e8e93;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:18px;color:#fff;margin:0 0 4px}p{color:#eee;font-size:13px;margin:0 0 16px}h2{font-size:13px;color:#fff;margin:20px 0 8px;font-weight:600}
.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.widget{border-radius:22px;overflow:hidden;flex:none;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.light{--label:#000;--secondary:rgba(60,60,67,.6);--tertiary:rgba(60,60,67,.3);--track:rgba(60,60,67,.12);color:#000}
.dark{--label:#fff;--secondary:rgba(235,235,245,.6);--tertiary:rgba(235,235,245,.3);--track:rgba(235,235,245,.16);color:#fff}
.widget>*{height:100%;width:100%}
</style></head><body><h1>GridBill 小组件布局预览（演示数据）</h1><p>这是在电脑上的近似渲染，用来看布局有没有溢出。图标是占位符，字体和间距和 iOS 有差别，最终效果以手机为准。</p>${body}</body></html>`

const out = path.join(__dirname, '..', 'preview.html')
fs.writeFileSync(out, html)
console.log(`已生成 ${out}`)
