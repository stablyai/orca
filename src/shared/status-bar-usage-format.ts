import type { ProviderRateLimits } from './rate-limit-types'

export type StatusBarUsageProvider = ProviderRateLimits['provider']

const STATUS_BAR_USAGE_PROVIDERS: ReadonlySet<string> = new Set<StatusBarUsageProvider>([
  'claude',
  'codex',
  'gemini',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'antigravity'
])

/** User-defined footer usage text. Empty `template` means Orca's built-in rendering. */
export type StatusBarUsageFormat = {
  template: string
  /** Per-provider templates that win over `template`; absent providers fall back to it. */
  byProvider?: Partial<Record<StatusBarUsageProvider, string>>
}

export const DEFAULT_STATUS_BAR_USAGE_FORMAT: StatusBarUsageFormat = { template: '' }

/** Plain-object guard for persisted JSON. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerces persisted/RPC input into a valid format, dropping unknown providers and non-string overrides. */
export function normalizeStatusBarUsageFormat(value: unknown): StatusBarUsageFormat {
  if (!isRecord(value)) {
    return { ...DEFAULT_STATUS_BAR_USAGE_FORMAT }
  }
  const template = typeof value.template === 'string' ? value.template : ''
  const byProvider: Partial<Record<StatusBarUsageProvider, string>> = {}
  if (isRecord(value.byProvider)) {
    for (const [provider, override] of Object.entries(value.byProvider)) {
      if (STATUS_BAR_USAGE_PROVIDERS.has(provider) && typeof override === 'string') {
        byProvider[provider as StatusBarUsageProvider] = override
      }
    }
  }
  return Object.keys(byProvider).length > 0 ? { template, byProvider } : { template }
}

/** The template to render for `provider`, or null when the built-in rendering should be used. */
export function resolveStatusBarUsageTemplate(
  format: StatusBarUsageFormat | null | undefined,
  provider: StatusBarUsageProvider
): string | null {
  if (!format) {
    return null
  }
  const override = format.byProvider?.[provider]
  if (override && override.trim()) {
    return override
  }
  return format.template.trim() ? format.template : null
}
