export type ClaudeAccountIdentity = {
  email?: string | null
  organizationUuid?: string | null
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export function claudeAccountDistroKey(distro: string | null | undefined): string {
  return distro?.trim().toLowerCase() || '__default__'
}

export function claudeAccountIdentityKey(account: ClaudeAccountIdentity): string | null {
  const email = account.email?.trim().toLowerCase()
  if (!email) {
    return null
  }
  return JSON.stringify([
    email,
    account.organizationUuid?.trim() || null,
    account.managedAuthRuntime ?? 'host',
    account.managedAuthRuntime === 'wsl' ? claudeAccountDistroKey(account.wslDistro) : null
  ])
}
