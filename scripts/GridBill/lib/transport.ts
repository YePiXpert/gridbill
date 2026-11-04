/**
 * 整个脚本唯一的联网出口。
 * 只放行国网 App 的接口地址，并拦截所有重定向（fetch 默认会自动跟随，官方文档有说明）。
 */
import { fetch } from 'scripting'
import { API_BASE, type Transport } from './protocol/client'

export const scriptingTransport: Transport = async (url, request) => {
  if (!url.startsWith(API_BASE)) throw new Error('拒绝连接国网以外的地址')
  const response = await fetch(url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    timeout: request.timeoutSeconds,
    handleRedirect: async () => null,
  })
  return { status: response.status, text: await response.text() }
}
