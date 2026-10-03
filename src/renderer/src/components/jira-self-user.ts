import type { JiraConnectionStatus, JiraUser } from '../../../shared/jira-types'

/**
 * The signed-in user for "Assign to me", resolved for a specific site because
 * account ids are site-scoped. The site's stored identity wins; the viewer
 * (active site's /myself) only stands in when the target site is the active
 * one or the setup has at most one site.
 */
export function getJiraSelfUser(
  status: JiraConnectionStatus | null | undefined,
  siteId: string | null | undefined
): JiraUser | null {
  const sites = status?.sites ?? []
  const site = siteId ? sites.find((candidate) => candidate.id === siteId) : null
  if (site?.accountId) {
    return {
      accountId: site.accountId,
      displayName: site.displayName || site.email || site.accountId
    }
  }
  const viewer = status?.viewer
  if (viewer?.accountId && (!siteId || siteId === status?.activeSiteId || sites.length <= 1)) {
    return {
      accountId: viewer.accountId,
      displayName: viewer.displayName,
      email: viewer.email,
      avatarUrl: viewer.avatarUrl
    }
  }
  return null
}
