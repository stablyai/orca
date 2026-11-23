// Chase's sign-in script sends any Electron UA to its "System Requirements" page.
const CHROME_SHAPED_SITE_DOMAINS = ['chase.com']
// Teams' server sends Electron request UAs to a blank page; its page script accepts them.
const TEAMS_HOSTS = new Set(['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'])

/** `hostname` is lowercase. */
export function isChromeShapedSiteHost(hostname: string): boolean {
  return CHROME_SHAPED_SITE_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  )
}

export function isTeamsHost(hostname: string): boolean {
  return TEAMS_HOSTS.has(hostname)
}

/** Sites whose requests may get a header rewrite in an embedded frame. */
export function isHeaderRewriteSiteHost(hostname: string): boolean {
  return isTeamsHost(hostname) || isChromeShapedSiteHost(hostname)
}
