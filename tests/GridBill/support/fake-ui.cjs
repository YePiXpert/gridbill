'use strict'
// 假的 scripting 模块：把 TSX 渲染成普通的树，用于 UI 冒烟测试和桌面预览。这不是真实的 SwiftUI 渲染。
const Module = require('node:module')
require('./shim.cjs')

globalThis.createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
globalThis.Fragment = 'Fragment'
globalThis.Dialog = { confirm: async () => true }

const NAMES = ['BarChart', 'Button', 'Chart', 'HStack', 'Image', 'LabeledContent', 'List', 'NavigationStack', 'Picker', 'ProgressView', 'RoundedRectangle', 'RuleLineForValueChart', 'Section', 'SecureField', 'Spacer', 'Text', 'TextField', 'VStack']

function createFakeScripting() {
  const fake = {
    Widget: { family: 'systemMedium', displaySize: { width: 338, height: 158 }, parameter: '', reloadAll() {}, preview: async () => {}, present() {} },
    Navigation: { useDismiss: () => () => {}, present: async () => {} },
    Script: { exit() {}, metadata: { version: '9.9.9', remoteResource: null } },
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    fetch: async () => {
      throw new Error('UI 测试不应该联网')
    },
  }
  for (const name of NAMES) fake[name] = name
  return fake
}

const fake = createFakeScripting()
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'scripting') return fake
  return originalLoad.call(this, request, parent, isMain)
}

/** 展开函数组件，得到只含基础组件的树。 */
function expand(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node !== 'object') return String(node)
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(expand).filter(child => child !== null) }
}

function texts(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (node) node.children.forEach(child => texts(child, out))
  return out
}

function findAll(node, type, out = []) {
  if (node && typeof node === 'object') {
    if (node.type === type) out.push(node)
    node.children.forEach(child => findAll(child, type, out))
  }
  return out
}

module.exports = { fake, expand, texts, findAll }
