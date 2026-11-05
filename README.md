# Scripting 脚本

运行在 iPhone [Scripting](https://scriptingapp.github.io/) App 里的脚本和小组件。每个脚本是一个独立的目录，手机上只会装你选的那一个。

| 脚本 | 说明 | 导入 |
|---|---|---|
| [GridBill 国网电费](scripts/GridBill) | 在桌面上看网上国网的余额、用电和阶梯进度，还有电费预计和账单对比（非官方） | [一键导入](https://scripting.fun/import_scripts?urls=%5B%22https%3A%2F%2Fgithub.com%2FYePiXpert%2Fscripting-scripts%2Ftree%2Fmain%2Fscripts%2FGridBill%22%5D) |

## 怎么导入

在装了 Scripting 的 iPhone 上点上面的“一键导入”，然后在 App 里确认。

链接打不开的话，打开 [Import Scripts](https://scripting.fun/import_scripts)，粘贴脚本的目录地址生成导入链接。目录地址的格式是：

```text
https://github.com/YePiXpert/scripting-scripts/tree/main/scripts/<脚本名>
```

**不能用仓库首页的地址导入。** 根目录没有 `script.json`，它不是一个脚本。

**更新时不要删除脚本。** 删除脚本会连它的钥匙串一起清掉。正确做法是在 App 的脚本设置里把远程来源设成脚本的目录地址，需要更新时手动检查。

**不建议打开自动更新。** 谁能往这个仓库推代码，谁就能让代码跑在你手机上，并读到这个脚本的钥匙串。

## 目录

```text
scripts/<脚本名>/    脚本本体，装到手机上的就是这个目录
tests/<脚本名>/      这个脚本的离线测试，不会同步到手机
tools/               语法检查等开发工具，不会同步到手机
dts/                 类型声明（占位，手机连接后被官方声明覆盖）
```

## 新增脚本

1. 在 `scripts/` 下新建一个目录，至少放 `script.json` 和 `index.tsx`。`script.json` 必须有 `name`、`icon`、`color`、`version`，`name` 和目录名保持一致。
2. 手机只拿到这个目录，所以不能 `import` 目录外面的文件。要共用的代码只能复制一份。
3. 说明写在脚本目录的 `README.md` 里，测试放到 `tests/<脚本名>/`。
4. 在上面的表格加一行，导入链接用 [Import Scripts](https://scripting.fun/import_scripts) 生成。

每个脚本的版本号各管各的，改了哪个就升哪个。

## 开发

```bash
npm install
```

```bash
npm run typecheck
```

```bash
npm test
```

`npm test` 会跑所有脚本的测试，并把 `scripts/` 下所有脚本按 TSX 解析一遍：Scripting 按 TSX 解析 `.ts` 文件，普通的类型检查查不出这类错误。

边改边在手机上看效果，可以用官方的同步工具。电脑和手机要在同一个局域网，Windows 防火墙弹窗时要允许局域网访问：

```bash
npx scripting-cli start
```

手机连接后，App 会把官方的 `.d.ts` 同步到 `dts/`，覆盖这里的占位声明，这时再跑一次类型检查才算完整。这些官方声明不要提交到仓库。

## 授权

各脚本的第三方授权说明在各自的目录里。
