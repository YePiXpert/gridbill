'use strict'
/**
 * 把脚本里的 .ts 全部当成 .tsx 解析一遍。
 *
 * 真机踩过的坑：Scripting 会按 TSX 解析 .ts 文件，`async <T>(x) => ...` 这种泛型箭头函数里的
 * <T> 会被当成 JSX 标签，生成坏代码（手机上报 const declared variable 'Promise' must have an
 * initializer）。普通的 tsc 按 .ts 解析，查不出来，所以单独检查。
 *
 * 用法：node tools/check-tsx-parse.cjs，有问题时退出码为 1。也可以 --emit 看生成的 JS。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const source = path.join(root, 'scripts', 'GridBill')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gridbill-tsx-'))

function copy(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const target = path.join(to, entry.name.replace(/\.ts$/, '.tsx'))
    if (entry.isDirectory()) copy(path.join(from, entry.name), target)
    else if (/\.tsx?$/.test(entry.name)) fs.copyFileSync(path.join(from, entry.name), target)
  }
}

copy(source, path.join(work, 'GridBill'))
fs.writeFileSync(
  path.join(work, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: { target: 'ESNext', module: 'CommonJS', jsx: 'react', jsxFactory: 'createElement', jsxFragmentFactory: 'Fragment', noCheck: true, outDir: 'out', types: [], skipLibCheck: true, noEmitOnError: false },
    include: ['GridBill'],
  }),
)

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const result = spawnSync(process.execPath, [tsc, '-p', work, '--pretty', 'false'], { encoding: 'utf8' })
const output = `${result.stdout}${result.stderr}`
// TS1xxx 和 TS17xxx 是语法错误；noCheck 之后不应该有类型错误，但这里只认语法错误。
const syntaxErrors = output.split(/\r?\n/).filter(line => /error TS(1\d{3}|17\d{3}):/.test(line))

if (process.argv.includes('--emit')) {
  for (const file of process.argv.slice(process.argv.indexOf('--emit') + 1)) {
    const js = path.join(work, 'out', file)
    console.log(`=== ${file}\n${fs.existsSync(js) ? fs.readFileSync(js, 'utf8') : '(没有生成)'}`)
  }
}

// 生成的 JS 也必须能被解析，这才是手机上真正报错的地方。
const brokenOutput = []
function checkOutput(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      checkOutput(full)
    } else if (entry.name.endsWith('.js')) {
      const check = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' })
      if (check.status !== 0) brokenOutput.push(`${path.relative(path.join(work, 'out'), full)}: ${check.stderr.split(/\r?\n/).find(line => /SyntaxError/.test(line))}`)
    }
  }
}
checkOutput(path.join(work, 'out'))

fs.rmSync(work, { recursive: true, force: true })

if (syntaxErrors.length || brokenOutput.length) {
  console.log(`TSX 解析发现 ${syntaxErrors.length} 个语法错误，${brokenOutput.length} 个生成的文件无法运行：`)
  for (const line of syntaxErrors) console.log(`  ${line.replace(/^GridBill[\\/]/, '')}`)
  for (const line of brokenOutput) console.log(`  生成结果 ${line}`)
  process.exit(1)
}
console.log('TSX 解析通过')
