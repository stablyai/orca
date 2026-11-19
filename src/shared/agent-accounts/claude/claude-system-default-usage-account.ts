export const CLAUDE_USAGE_ACCOUNT_ID_ENV = 'ORCA_CLAUDE_USAGE_ACCOUNT_ID'

function encodeIdentityField(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return '-'
  }
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

export function claudeSystemDefaultUsageAccountId(
  email: string | null | undefined,
  organizationUuid: string | null | undefined
): string {
  return `system-default:host:${encodeIdentityField(email)}:${encodeIdentityField(organizationUuid)}`
}
