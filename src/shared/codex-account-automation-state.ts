export const CODEX_WARMING_STATUSES = [
  'waiting',
  'deferred',
  'attempting',
  'unconfirmed',
  'verified',
  'unavailable'
] as const
export type CodexWarmingStatus = (typeof CODEX_WARMING_STATUSES)[number]

export type CodexAccountAutomationState = {
  warming: Record<
    string,
    { status: CodexWarmingStatus; updatedAt: number; nextResetAt: number | null }
  >
  failure?: string
}

export function isCodexFailoverHomes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every((home) => typeof home === 'string' && home.length <= 32_768 && !home.includes('\0'))
  )
}
