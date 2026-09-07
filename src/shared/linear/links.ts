import type { LinearIssue } from './issue-types'
import type { LinearConnectionStatus, LinearWorkspace } from './workspace-types'

export function buildLinearTeamUrl(args: {
  organizationUrlKey?: string | null
  teamKey?: string | null
}): string | null {
  const organizationUrlKey = args.organizationUrlKey?.trim()
  const teamKey = args.teamKey?.trim()
  if (!organizationUrlKey || !teamKey) {
    return null
  }
  return `https://linear.app/${encodeURIComponent(organizationUrlKey)}/team/${encodeURIComponent(teamKey)}/all`
}

export function buildLinearPersonalApiKeySettingsUrl(organizationUrlKey?: string | null): string {
  const trimmed = organizationUrlKey?.trim()
  return trimmed
    ? `https://linear.app/${encodeURIComponent(trimmed)}/settings/account/security`
    : 'https://linear.app/settings/account/security'
}

export function buildLinearWorkspaceApiSettingsUrl(organizationUrlKey?: string | null): string {
  const trimmed = organizationUrlKey?.trim()
  return trimmed
    ? `https://linear.app/${encodeURIComponent(trimmed)}/settings/api`
    : 'https://linear.app/settings/api'
}

export function buildLinearIssueUrl(args: {
  identifier?: string | null
  organizationUrlKey?: string | null
}): string | null {
  const identifier = args.identifier?.trim()
  const organizationUrlKey = args.organizationUrlKey?.trim()
  if (!identifier || !organizationUrlKey) {
    return null
  }
  return `https://linear.app/${encodeURIComponent(organizationUrlKey)}/issue/${encodeURIComponent(identifier)}`
}

export function getLinearOrganizationUrlKeyFromIssueUrl(issueUrl?: string | null): string | null {
  if (!issueUrl) {
    return null
  }
  try {
    const parsed = new URL(issueUrl)
    if (parsed.hostname !== 'linear.app') {
      return null
    }
    return parsed.pathname.split('/').find(Boolean) ?? null
  } catch {
    return null
  }
}

export type ParsedLinearIssueInput = {
  identifier: string
  organizationUrlKey?: string
}

export type LinearIssueUrlIntent = {
  identifier: string
  organizationUrlKey: string
}

export type LinearIssueLinkUpdates = {
  linkedLinearIssue: string | null
  linkedLinearIssueWorkspaceId: string | null
  linkedLinearIssueOrganizationUrlKey: string | null
}

const LINEAR_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

export function parseLinearIssueInput(input: string): ParsedLinearIssueInput | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  if (LINEAR_IDENTIFIER_PATTERN.test(trimmed)) {
    return { identifier: trimmed.toUpperCase() }
  }

  try {
    const parsed = new URL(trimmed)
    // Why: hostname alone accepts file://linear.app/..., which then passes
    // validation and persists as a link. The GitHub parser already gates on
    // protocol; this keeps the two in step.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null
    }
    if (parsed.hostname !== 'linear.app') {
      return null
    }
    const parts = parsed.pathname.split('/').filter(Boolean)
    const issueIndex = parts.indexOf('issue')
    const organizationUrlKey = parts[0]
    const rawIdentifier = issueIndex !== -1 ? parts[issueIndex + 1] : undefined
    if (!organizationUrlKey || !rawIdentifier) {
      return null
    }
    const identifier = decodeURIComponent(rawIdentifier).split(/[/?#]/)[0]
    if (!LINEAR_IDENTIFIER_PATTERN.test(identifier)) {
      return null
    }
    return {
      identifier: identifier.toUpperCase(),
      organizationUrlKey: decodeURIComponent(organizationUrlKey)
    }
  } catch {
    return null
  }
}

export function parseLinearIssueUrlIntent(input: string): LinearIssueUrlIntent | null {
  const trimmed = input.trim()
  try {
    const url = new URL(trimmed)
    const pathMatch = /^\/([^/]+)\/issue\/([^/]+)(?:\/[^/]+)?\/?$/.exec(url.pathname)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.host !== 'linear.app' ||
      url.username !== '' ||
      url.password !== '' ||
      !pathMatch
    ) {
      return null
    }
    const organizationUrlKey = decodeURIComponent(pathMatch[1])
    const identifier = decodeURIComponent(pathMatch[2])
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(organizationUrlKey) ||
      !LINEAR_IDENTIFIER_PATTERN.test(identifier)
    ) {
      return null
    }
    return { identifier: identifier.toUpperCase(), organizationUrlKey }
  } catch {
    return null
  }
}

export function findLinearIssueWorkspaceId(
  intent: LinearIssueUrlIntent,
  workspaces: readonly Pick<LinearWorkspace, 'id' | 'organizationUrlKey'>[] | undefined
): string | null {
  const organizationUrlKey = intent.organizationUrlKey.toLowerCase()
  return (
    workspaces?.find(
      (workspace) => workspace.organizationUrlKey?.toLowerCase() === organizationUrlKey
    )?.id ?? null
  )
}

export function findLinearIssueWorkspaceIdFromStatus(
  intent: LinearIssueUrlIntent,
  status: Pick<
    LinearConnectionStatus,
    'workspaces' | 'viewer' | 'activeWorkspaceId' | 'selectedWorkspaceId'
  >
): string | null {
  const workspaceId = findLinearIssueWorkspaceId(intent, status.workspaces)
  if (workspaceId) {
    return workspaceId
  }
  if (
    status.viewer?.organizationUrlKey?.toLowerCase() !== intent.organizationUrlKey.toLowerCase()
  ) {
    return null
  }
  const selectedWorkspaceId =
    status.selectedWorkspaceId && status.selectedWorkspaceId !== 'all'
      ? status.selectedWorkspaceId
      : null
  return selectedWorkspaceId ?? status.activeWorkspaceId ?? null
}

export function findLinearIssueWorkspaceLookupIds(
  intent: LinearIssueUrlIntent,
  status: Pick<
    LinearConnectionStatus,
    'workspaces' | 'viewer' | 'activeWorkspaceId' | 'selectedWorkspaceId'
  >
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const push = (id: string | null | undefined): void => {
    if (!id || id === 'all' || seen.has(id)) {
      return
    }
    seen.add(id)
    ids.push(id)
  }

  push(findLinearIssueWorkspaceIdFromStatus(intent, status))

  // Why: saved API-key workspaces often omit organizationUrlKey. Probe those
  // unknown-org workspaces and accept only an issue whose URL matches the org.
  for (const workspace of status.workspaces ?? []) {
    if (!workspace.organizationUrlKey) {
      push(workspace.id)
    }
  }

  if (!status.viewer?.organizationUrlKey && (status.workspaces?.length ?? 0) === 0) {
    const selectedWorkspaceId =
      status.selectedWorkspaceId && status.selectedWorkspaceId !== 'all'
        ? status.selectedWorkspaceId
        : null
    push(selectedWorkspaceId)
    push(status.activeWorkspaceId)
  }

  return ids
}

export function isLinearIssueUrlResolutionMatch(
  intent: LinearIssueUrlIntent,
  issue: Pick<LinearIssue, 'identifier' | 'url'>
): boolean {
  if (issue.identifier.toUpperCase() !== intent.identifier.toUpperCase()) {
    return false
  }
  const issueOrganizationUrlKey = getLinearOrganizationUrlKeyFromIssueUrl(issue.url)
  return (
    issueOrganizationUrlKey !== null &&
    issueOrganizationUrlKey.toLowerCase() === intent.organizationUrlKey.toLowerCase()
  )
}

export const LINEAR_ISSUE_LINK_CLEARED: LinearIssueLinkUpdates = {
  linkedLinearIssue: null,
  linkedLinearIssueWorkspaceId: null,
  linkedLinearIssueOrganizationUrlKey: null
}

/** Shared by the CLI and the meta dialog so both persist identical state for
 *  identical input. Returns null when the input is neither empty nor parseable. */
export function buildLinearIssueLinkUpdates(input: string): LinearIssueLinkUpdates | null {
  if (input.trim() === '') {
    return { ...LINEAR_ISSUE_LINK_CLEARED }
  }

  const parsed = parseLinearIssueInput(input)
  if (!parsed) {
    return null
  }

  return {
    linkedLinearIssue: parsed.identifier,
    // Both scoping fields describe the issue being REPLACED. A stale org key
    // pins resolveLegacyLinearLinkWorkspace to the wrong org — not-found, or a
    // silently wrong issue on a prefix collision. Nulling only costs a re-read.
    linkedLinearIssueWorkspaceId: null,
    linkedLinearIssueOrganizationUrlKey: parsed.organizationUrlKey ?? null
  }
}
