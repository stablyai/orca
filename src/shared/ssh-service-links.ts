import type { SshServiceLink } from './ssh-types'

export const MAX_SSH_SERVICE_LINKS = 12
export const MAX_SSH_SERVICE_LINK_LABEL_LENGTH = 60
export const MAX_SSH_SERVICE_LINK_URL_LENGTH = 2048

// Why: the one http(s) rule, used by both the edit form and persisted-data normalization.
function normalizeSshServiceLinkUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const url = value.trim()
  if (!url || url.length > MAX_SSH_SERVICE_LINK_URL_LENGTH) {
    return null
  }
  try {
    const parsed = new URL(url)
    // Why: only http(s) ever reaches a click handler or a browser tab — file:,
    // javascript: and other schemes are rejected here, not at open time. A
    // hostless http(s) form (`https:`) fails to parse for special schemes.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    // Why: userinfo lets a link read like one host and open another (https://grafana@evil.example).
    return parsed.username || parsed.password ? null : url
  } catch {
    return null
  }
}

function normalizeSshServiceLinkLabel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const label = value.trim()
  return label.length >= 1 && label.length <= MAX_SSH_SERVICE_LINK_LABEL_LENGTH ? label : null
}

export function normalizeSshServiceLink(value: unknown): SshServiceLink | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowing an unknown for field-by-field validation; both fields are checked before use.
  const raw = value as Partial<SshServiceLink>
  const label = normalizeSshServiceLinkLabel(raw.label)
  const url = normalizeSshServiceLinkUrl(raw.url)
  return label && url ? { label, url } : null
}

/** Drops unusable entries and truncates at the cap. `undefined` means "no links",
 *  which is what persistence stores so the field disappears entirely. */
export function normalizeSshServiceLinks(value: unknown): SshServiceLink[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const links: SshServiceLink[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const link = normalizeSshServiceLink(entry)
    // Why dedupe: identical links add nothing and would collide as render keys on the card.
    const identity = link ? `${link.url}\u0000${link.label}` : ''
    if (!link || seen.has(identity)) {
      continue
    }
    seen.add(identity)
    links.push(link)
    if (links.length === MAX_SSH_SERVICE_LINKS) {
      break
    }
  }
  return links.length > 0 ? links : undefined
}
