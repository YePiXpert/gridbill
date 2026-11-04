'use strict'
// 真机踩过的坑：Scripting 按 TSX 解析 .ts 文件。这里按同样的方式解析全部源码，并确认生成的 JS 能运行。
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

test('所有脚本文件按 TSX 解析都没有语法错误', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'check-tsx-parse.cjs')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
