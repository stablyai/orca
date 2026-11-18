import type { CodexSystemDefaultIdentity } from '../managed-account-types'

export function codexSystemDefaultUsageKey(
  identity: CodexSystemDefaultIdentity | undefined
): string | null {
  return identity?.hasAuth && identity.authKind === 'oauth'
    ? `system-default:host:${JSON.stringify([identity.email, identity.providerAccountId])}`
    : null
}
