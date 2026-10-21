// Why: GitHub owner logins are alphanumerics and single hyphens — plus, for
// Enterprise Managed Users, the `_<shortcode>` GitHub itself appends — so `_` is
// valid after the first character and never leading. One source for main, renderer
// and mobile: three drifting copies is how EMU logins got rejected (#20449).
const OWNER_SLUG_SOURCE = '[A-Za-z0-9][A-Za-z0-9_-]*'

export const GITHUB_OWNER_SLUG_RE = new RegExp(`^${OWNER_SLUG_SOURCE}$`)

/** `owner/123` shorthand — match[1] is the owner, match[2] the number. */
export const GITHUB_OWNER_NUMBER_SHORTHAND_RE = new RegExp(`^(${OWNER_SLUG_SOURCE})\\/(\\d+)$`)

export function isGitHubOwnerSlug(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_OWNER_SLUG_RE.test(value)
}
