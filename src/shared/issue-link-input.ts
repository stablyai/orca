import { parseGitHubIssueOrPRLink } from './github/links'
import { parseLinearIssueInput } from './linear/links'
import type { WorkspaceSourceProvider } from './new-workspace/workspace-source'
import { isWorkItemLinkQueryTooLarge } from './new-workspace/work-item-link-query-bounds'

// Why: narrows the canonical provider union instead of minting a parallel one,
// so adding Jira here is a one-entry change rather than a new axis. 'other' is
// the exception: a stored URL with no fetcher, so it stays out of the task-source union.
export const ISSUE_LINK_PROVIDERS = ['github', 'linear', 'other'] as const satisfies readonly (
  | WorkspaceSourceProvider
  | 'other'
)[]

export type IssueLinkProvider = (typeof ISSUE_LINK_PROVIDERS)[number]

export function isIssueLinkProvider(value: unknown): value is IssueLinkProvider {
  return ISSUE_LINK_PROVIDERS.includes(value as IssueLinkProvider)
}

/** URL input only. Linear and Jira issue keys are byte-identical in shape, so a
 *  bare `STA-335` can never decide a provider — it would override the chip. */
export function getIssueLinkProviderFromUrl(input: string): IssueLinkProvider | null {
  const trimmed = input.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    return null
  }

  // Why: a URL is decisive only if it names that provider's *issue*. A GitHub
  // pull URL is a valid GitHub link but not an issue, and must not flip the
  // provider into a state where the field then refuses to save it.
  if (parseGitHubIssueOrPRLink(trimmed)?.type === 'issue') {
    return 'github'
  }
  if (parseLinearIssueInput(trimmed)) {
    return 'linear'
  }
  // Why: GitHub and Linear own their hosts — a pull or team URL there is a
  // mistake for those providers, not a generic link.
  const url = parseIssueUrl(trimmed)
  if (url) {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'github.com' || host === 'www.github.com' || host === 'linear.app'
      ? null
      : 'other'
  }
  return null
}

/** An http(s) URL saved as-is for the 'other' provider, or null. */
export function parseIssueUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed || isWorkItemLinkQueryTooLarge(trimmed)) {
    return null
  }
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null
  } catch {
    return null
  }
}

/** Short label for a stored issue URL: its host, or the raw value if unparseable. */
export function getIssueUrlHostname(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

export type ParsedIssueLinkInput =
  | { provider: 'github'; number: number }
  | { provider: 'linear'; identifier: string; organizationUrlKey?: string }
  | { provider: 'other'; url: string }

/**
 * Single parse shared by the dialog's save gate and its payload builder, so a
 * value that enables Save is always the value that gets written.
 */
export function parseIssueLinkInput(
  input: string,
  provider: IssueLinkProvider
): ParsedIssueLinkInput | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  if (provider === 'linear') {
    const parsed = parseLinearIssueInput(trimmed)
    return parsed ? { provider: 'linear', ...parsed } : null
  }

  if (provider === 'other') {
    const url = parseIssueUrl(trimmed)
    return url ? { provider: 'other', url } : null
  }

  const link = parseGitHubIssueOrPRLink(trimmed)
  if (link) {
    // Why: issue and PR numbers live in separate GitHub namespaces for refs; a
    // pull URL pasted here must not silently become an issue link.
    return link.type === 'issue' ? { provider: 'github', number: link.number } : null
  }

  const numeric = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  if (!/^\d+$/.test(numeric)) {
    return null
  }
  const parsed = Number.parseInt(numeric, 10)
  // Why: `/^\d+$/` happily accepts 400 digits, which parseInt turns into
  // Infinity — Save would enable and JSON.stringify would persist `null`.
  return Number.isSafeInteger(parsed) && parsed > 0 ? { provider: 'github', number: parsed } : null
}
