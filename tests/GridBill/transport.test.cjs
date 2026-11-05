'use strict'
// 联网出口：白名单和重定向拦截。用假的 scripting 模块记录 fetch 的参数。
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
require('./support/shim.cjs')

const calls = []
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'scripting') {
    return {
      fetch: async (url, init) => {
        calls.push({ url, init })
        return { status: 200, text: async () => 'body' }
      },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { scriptingTransport } = require('../../.build/GridBill/lib/transport')
Module._load = originalLoad

const request = { headers: { a: 'b' }, body: 'x', timeoutSeconds: 20 }

test('只放行国网接口地址', async () => {
  const blocked = [
    'https://evil.example.com/',
    'http://csc-service.sgcc.com.cn:28630/x',
    'https://csc-service.sgcc.com.cn/x',
    'https://csc-service.sgcc.com.cn:28630.evil.com/x',
    'https://csc-service.sgcc.com.cn.evil.com:28630/x',
    'https://api.120399.xyz/',
  ]
  for (const url of blocked) {
    await assert.rejects(scriptingTransport(url, request), /拒绝连接/, url)
  }
  assert.equal(calls.length, 0, '被拒绝的地址一个请求都不能发出')
})

test('合法请求带上重定向拦截', async () => {
  const result = await scriptingTransport('https://csc-service.sgcc.com.cn:28630/emss/x', request)
  assert.deepEqual(result, { status: 200, text: 'body' })
  const { init } = calls[0]
  assert.equal(init.method, 'POST')
  assert.equal(init.timeout, 20)
  assert.equal(init.body, 'x')
  assert.equal(await init.handleRedirect({ url: 'https://evil.example.com/' }), null, '任何重定向都要取消')
  assert.equal(init.debugLabel, undefined, '不进日志面板')
  assert.equal(init.allowInsecureRequest, undefined)
})
