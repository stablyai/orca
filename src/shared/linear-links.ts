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
