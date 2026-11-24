/** Display label for a Jira login; its identity is the host plus providerIdentity.siteId. */
export function getJiraAccountLabel(
  account:
    | { email?: string | null; displayName?: string | null; siteUrl?: string | null }
    | null
    | undefined
): string | null {
  return account?.email?.trim() || account?.displayName?.trim() || account?.siteUrl?.trim() || null
}
