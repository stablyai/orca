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

export function getLinearOrganizationUrlKeyFromIssueUrl(issueUrl?: string | null): string | null {
  if (!issueUrl) {
    return null
  }
  try {
    const parsed = new URL(issueUrl)
    if (parsed.hostname !== 'linear.app') {
      return null
    }
    return parsed.pathname.split('/').filter(Boolean)[0] ?? null
  } catch {
    return null
  }
}

export type ParsedLinearIssueInput = {
  identifier: string
  organizationUrlKey?: string
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
    if (parsed.hostname !== 'linear.app') {
      return null
    }
    const parts = parsed.pathname.split('/').filter(Boolean)
    const issueIndex = parts.indexOf('issue')
    const organizationUrlKey = parts[0]
    const rawIdentifier = issueIndex >= 0 ? parts[issueIndex + 1] : undefined
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
