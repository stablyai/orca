import type { JiraSite } from './jira-types'

function getJiraSiteHost(siteUrl: string): string {
  return siteUrl
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
}

// Why the host: displayName is the connected user's name, so it repeats across sites.
export function getJiraSiteLabel(site: Pick<JiraSite, 'displayName' | 'siteUrl'>): string {
  const name = site.displayName.trim()
  const host = getJiraSiteHost(site.siteUrl)
  if (!name || name === host) {
    return host || name
  }
  return host ? `${name} (${host})` : name
}

/** Relabel an issue from its stored site; older remote hosts still send a name-only siteName. */
export function withJiraSiteLabel<T extends { siteId?: string; siteName?: string }>(
  issue: T,
  sites: readonly Pick<JiraSite, 'id' | 'displayName' | 'siteUrl'>[]
): T {
  const site = issue.siteId ? sites.find((candidate) => candidate.id === issue.siteId) : undefined
  if (!site) {
    return issue
  }
  const siteName = getJiraSiteLabel(site)
  // Same object when already labeled, so memoized rows keep their identity.
  return issue.siteName === siteName ? issue : { ...issue, siteName }
}
