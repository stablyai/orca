export type ClaudeManagedAccountLabelSource = {
  email: string
  displayName?: string | null
  organizationName?: string | null
}

export function normalizeClaudeManagedAccountDisplayName(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

/** Custom name wins; otherwise email · org when an org name exists; otherwise email. */
export function getClaudeManagedAccountLabel(account: ClaudeManagedAccountLabelSource): string {
  const displayName = normalizeClaudeManagedAccountDisplayName(account.displayName)
  if (displayName) {
    return `${displayName} (${account.email})`
  }
  const organizationName = account.organizationName?.trim()
  if (organizationName) {
    return `${account.email} · ${organizationName}`
  }
  return account.email
}
