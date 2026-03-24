const GH_ITEM_PATH_RE = /^\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)(?:\/)?$/i

/**
 * Parses a GitHub issue/PR reference from plain input.
 * Supports issue/PR numbers (e.g. "42"), "#42", and full GitHub URLs.
 */
export function parseGitHubIssueOrPRNumber(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  const numeric = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  if (/^\d+$/.test(numeric)) {
    return Number.parseInt(numeric, 10)
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) {
    return null
  }

  const match = GH_ITEM_PATH_RE.exec(url.pathname)
  if (!match) {
    return null
  }

  return Number.parseInt(match[1], 10)
}
