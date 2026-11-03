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
