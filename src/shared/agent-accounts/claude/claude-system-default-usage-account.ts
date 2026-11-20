export const CLAUDE_USAGE_ACCOUNT_ID_ENV = 'ORCA_CLAUDE_USAGE_ACCOUNT_ID'

export function claudeSystemDefaultUsageAccountId(
  email: string | null | undefined,
  organizationUuid: string | null | undefined
): string | null {
  if (!email && !organizationUuid) {
    return null
  }
  return `system-default:host:${JSON.stringify([email ?? null, organizationUuid ?? null])}`
}
