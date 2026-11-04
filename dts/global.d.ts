/**
 * 本地占位声明，只覆盖这个脚本用到的全局 API，内容按官方文档手写。
 *
 * 官方的真实声明不公开发布，只有手机通过 `npx scripting-cli start` 连上后才会同步到 dts/ 目录，
 * 到时会覆盖这个文件。那之后再跑一次 `npm run typecheck`，检查才算完整。
 */

declare class Data {
  static fromUint8Array(bytes: Uint8Array): Data | null
  toUint8Array(): Uint8Array | null
}

declare namespace Crypto {
  function generateSymmetricKey(size?: number): Data
  function md5(data: Data): Data
  function hmacSHA256(data: Data, key: Data): Data
}

declare namespace Keychain {
  function get(key: string): string | null
  function set(key: string, value: string): boolean
  function remove(key: string): boolean
  function clear(): boolean
}

declare namespace Storage {
  function get<T>(key: string): T | null
  function set<T>(key: string, value: T): boolean
  function clear(): void
}

declare namespace Dialog {
  function confirm(options: { message: string; title?: string; cancelLabel?: string; confirmLabel?: string }): Promise<boolean>
}

declare function createElement(type: unknown, props: unknown, ...children: unknown[]): any
declare const Fragment: unknown

declare namespace JSX {
  type Element = any
  interface ElementChildrenAttribute {
    children: {}
  }
  interface IntrinsicAttributes {
    key?: string | number
  }
}

