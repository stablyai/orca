import type { JiraConnectionStatus, JiraUser } from '../../../shared/jira-types'

// Site identities take precedence over the active site's viewer.
export function getJiraSelfUser(
  status: JiraConnectionStatus | null | undefined,
  siteId: string | null | undefined
): JiraUser | null {
  if (!status?.connected) {
    return null
  }
  const sites = status?.sites ?? []
  const site = siteId ? sites.find((candidate) => candidate.id === siteId) : null
  if (site?.accountId) {
    return {
      accountId: site.accountId,
      displayName: site.displayName || site.email || site.accountId
    }
  }
  const viewer = status?.viewer
  if (
    viewer?.accountId &&
    (!siteId || siteId === status.activeSiteId || (site?.id === siteId && sites.length === 1))
  ) {
    return {
      accountId: viewer.accountId,
      displayName: viewer.displayName,
      email: viewer.email,
      avatarUrl: viewer.avatarUrl
    }
  }
  return null
}
