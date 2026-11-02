export type ParsedPlaneIssueLink = {
  workspaceSlug: string
  projectId: string
  issueId: string
}

/**
 * Parses a Plane issue URL.
 * Supported formats:
 * - https://app.plane.so/[workspaceSlug]/projects/[projectId]/issues/[issueId]
 * - https://[custom-domain]/[workspaceSlug]/projects/[projectId]/issues/[issueId]
 */
export function parsePlaneIssueUrl(url: string): ParsedPlaneIssueLink | null {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    return null
  }

  try {
    const parsed = new URL(trimmed)
    const segments = parsed.pathname.split('/').filter(Boolean)
    // Format: /:workspace/projects/:projectId/issues/:issueId
    if (segments.length >= 5 && segments[1] === 'projects' && segments[3] === 'issues') {
      const workspaceSlug = segments[0]
      const projectId = segments[2]
      const issueId = segments[4]
      if (workspaceSlug && projectId && issueId) {
        return { workspaceSlug, projectId, issueId }
      }
    }
    return null
  } catch {
    return null
  }
}

export function buildPlaneIssueUrl(
  instanceUrl: string,
  workspaceSlug: string,
  projectId: string,
  issueId: string
): string {
  const base = instanceUrl.replace(/\/+$/, '')
  return `${base}/${workspaceSlug}/projects/${projectId}/issues/${issueId}`
}

export function buildPlaneApiTokensUrl(instanceUrl: string): string {
  const base = instanceUrl.replace(/\/+$/, '')
  return `${base}/profile/api-tokens`
}
