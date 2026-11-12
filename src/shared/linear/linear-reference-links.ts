const LINEAR_ISSUE_URL_PATTERN =
  /^https:\/\/linear\.app\/([A-Za-z0-9_-]+)\/issue\/([A-Z][A-Z0-9_]{0,9}-[1-9][0-9]{0,6})(?:[/?#]|$)/

/** The URL a Linear identifier is appended to for an organization. */
export function linearIssueUrlPrefix(orgUrlKey: string): string {
  return `https://linear.app/${encodeURIComponent(orgUrlKey)}/issue/`
}

/** The issue a linear.app issue URL names; null for any other URL. */
export function parseLinearIssueUrl(
  href: string | undefined
): { orgUrlKey: string; identifier: string } | null {
  const match = href ? LINEAR_ISSUE_URL_PATTERN.exec(href) : null
  return match?.[1] && match[2] ? { orgUrlKey: match[1], identifier: match[2] } : null
}
