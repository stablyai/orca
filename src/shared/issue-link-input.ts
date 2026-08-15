import { parseGitHubIssueOrPRLink } from './github/links'
import { parseLinearIssueInput } from './linear/links'
import { parsePlaneIssueLink } from './plane/links'
import type { WorkspaceSourceProvider } from './new-workspace/workspace-source'

export const ISSUE_LINK_PROVIDERS = [
  'github',
  'linear',
  'plane'
] as const satisfies readonly WorkspaceSourceProvider[]

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
  if (parsePlaneIssueLink(trimmed)) {
    return 'plane'
  }
  return null
}

export type ParsedIssueLinkInput =
  | { provider: 'github'; number: number }
  | { provider: 'linear'; identifier: string; organizationUrlKey?: string }
  | { provider: 'plane'; identifier: string; workspaceSlug?: string; baseUrl?: string }

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

  if (provider === 'plane') {
    const parsed = parsePlaneIssueLink(trimmed)
    return parsed
      ? {
          provider: 'plane',
          identifier: parsed.identifier,
          workspaceSlug: parsed.workspaceSlug,
          baseUrl: parsed.baseUrl
        }
      : null
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
