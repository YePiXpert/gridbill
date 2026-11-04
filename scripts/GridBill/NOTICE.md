# 第三方说明

`lib/protocol/` 里的网上国网协议和设备令牌算法，以及 `lib/protocol/turing-data.ts` 里的参考数据，移植自
[stevenjoezhang/hass-state-grid](https://github.com/stevenjoezhang/hass-state-grid)，依据以下 MIT 许可：

```text
MIT License

Copyright (c) 2026 stevenjoezhang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

这是非官方实现，与国家电网没有隶属或授权关系。它使用网上国网 App 的非公开接口，可能随时失效；
所有账单和用电数据以官方 App 为准。请只用于你本人的账户。
