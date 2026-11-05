/**
 * 本地占位声明，说明见 global.d.ts。组件的属性这里不做检查，
 * 属性名和取值是对照官方文档逐个核过的；手机连上 scripting-cli 后会被真实声明覆盖。
 */
type View = (props: Record<string, any>) => any

export declare const BarChart: View
export declare const Button: View
export declare const Chart: View
export declare const HStack: View
export declare const Image: View
export declare const LabeledContent: View
export declare const List: View
export declare const NavigationStack: View
export declare const Picker: View
export declare const ProgressView: View
export declare const RoundedRectangle: View
export declare const RuleLineForValueChart: View
export declare const Section: View
export declare const SecureField: View
export declare const Spacer: View
export declare const Text: View
export declare const TextField: View
export declare const VStack: View

export declare function useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void]

export declare const Navigation: {
  present(element: unknown): Promise<void>
  useDismiss(): () => void
}

export declare const Script: {
  exit(result?: unknown): void
  readonly metadata: {
    version?: string
    remoteResource?: { url: string; autoUpdateInterval?: number | null } | null
  }
}

export declare const Widget: {
  readonly family: string
  readonly displaySize: { width: number; height: number }
  readonly parameter: string
  present(element: unknown, reloadPolicy?: { policy: 'atEnd' } | { policy: 'after'; date: Date }): void
  preview(options?: { family?: string; parameters?: { options: Record<string, string>; default: string } }): Promise<void>
  reloadAll(): void
}

export declare function fetch(
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeout?: number
    handleRedirect?: (request: unknown) => Promise<unknown | null>
  },
): Promise<{ status: number; ok: boolean; text(): Promise<string> }>
