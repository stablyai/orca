// Share owner grammar across main/renderer/mobile, including EMU _shortcode suffixes (#20449); leading underscores remain invalid.
const OWNER_SLUG_SOURCE = '[A-Za-z0-9][A-Za-z0-9_-]*'

export const GITHUB_OWNER_SLUG_RE = new RegExp(`^${OWNER_SLUG_SOURCE}$`)

/** `owner/123` shorthand — match[1] is the owner, match[2] the number. */
export const GITHUB_OWNER_NUMBER_SHORTHAND_RE = new RegExp(`^(${OWNER_SLUG_SOURCE})\\/(\\d+)$`)

export function isGitHubOwnerSlug(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_OWNER_SLUG_RE.test(value)
}
