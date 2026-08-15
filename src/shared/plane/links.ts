export type PlaneIssueLink = {
  baseUrl?: string
  workspaceSlug?: string
  projectIdentifier: string
  sequenceId: number
  identifier: string
}

const PLANE_IDENTIFIER_PATTERN = /^([A-Z][A-Z0-9_]*)-(\d+)$/i
const PLANE_ISSUE_ROUTE_SEGMENTS = new Set(['issues', 'work-items'])

export function parsePlaneIssueLink(input: string): PlaneIssueLink | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  const direct = parsePlaneIdentifier(trimmed)
  if (direct) {
    return direct
  }
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null
    }
    const pathParts = url.pathname.split('/').filter(Boolean)
    const issueRouteIndex = pathParts.findIndex((part) => PLANE_ISSUE_ROUTE_SEGMENTS.has(part))
    const identifier = pathParts.find((part, index) =>
      index > issueRouteIndex && PLANE_IDENTIFIER_PATTERN.test(part)
    )
    const parsed = identifier ? parsePlaneIdentifier(identifier) : null
    if (!parsed) {
      return null
    }
    const workspaceIndex = pathParts.indexOf('workspaces')
    const routeWorkspaceSlug = issueRouteIndex > 0 ? pathParts[issueRouteIndex - 1] : undefined
    return {
      ...parsed,
      baseUrl: url.origin,
      workspaceSlug:
        workspaceIndex !== -1 && pathParts[workspaceIndex + 1]
          ? pathParts[workspaceIndex + 1]
          : routeWorkspaceSlug
    }
  } catch {
    return null
  }
}

function parsePlaneIdentifier(value: string): PlaneIssueLink | null {
  const match = PLANE_IDENTIFIER_PATTERN.exec(value)
  if (!match) {
    return null
  }
  const projectIdentifier = match[1].toUpperCase()
  const sequenceId = Number(match[2])
  return {
    projectIdentifier,
    sequenceId,
    identifier: `${projectIdentifier}-${sequenceId}`
  }
}
