const ISSUE_ID_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/
const ISSUE_PATH_RE = /\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:\/|$)/

export function isYouTrackIssueId(value: string): boolean {
  return ISSUE_ID_RE.test(value)
}

/** Reads a YouTrack issue ID from a bare ID ("proj-81") or an issue URL on the connected instance. */
export function parseYouTrackIssueReference(value: string, baseUrl: string | null): string | null {
  const trimmed = value.trim()
  if (isYouTrackIssueId(trimmed)) {
    return trimmed.toUpperCase()
  }
  if (!baseUrl || !/^https?:\/\//i.test(trimmed)) {
    return null
  }
  try {
    const url = new URL(trimmed)
    const base = new URL(baseUrl)
    const basePath = base.pathname.replace(/\/+$/, '')
    // Why: only URLs on the connected instance; other trackers' URLs share the ID shape.
    if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`)) {
      return null
    }
    const match = ISSUE_PATH_RE.exec(url.pathname.slice(basePath.length))
    return match ? match[1].toUpperCase() : null
  } catch {
    return null
  }
}

const ID_PREFIX_RE = /^[A-Za-z][A-Za-z0-9_]*-\d*$/

/** Reads a typed ID prefix ("proj-", "proj-8") used to suggest matching issues. */
export function parseYouTrackIssueIdPrefix(value: string): string | null {
  const trimmed = value.trim()
  return ID_PREFIX_RE.test(trimmed) ? trimmed.toUpperCase() : null
}

/** True when Smart-field text was only the lookup that found this issue: its ID, an ID prefix, or its URL. */
export function isYouTrackLookupTextFor(
  text: string,
  issue: { idReadable: string; url: string }
): boolean {
  const trimmed = text.trim()
  const prefix = parseYouTrackIssueIdPrefix(trimmed)
  if (prefix) {
    return issue.idReadable.toUpperCase().startsWith(prefix)
  }
  const issuePathIndex = issue.url.lastIndexOf('/issue/')
  const baseUrl = issuePathIndex > 0 ? issue.url.slice(0, issuePathIndex) : null
  return parseYouTrackIssueReference(trimmed, baseUrl) === issue.idReadable.toUpperCase()
}
