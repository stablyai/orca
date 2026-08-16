export type PlaneIssueLink = {
  baseUrl?: string
  workspaceSlug?: string
  projectIdentifier: string
  sequenceId: number
  identifier: string
}

const PLANE_IDENTIFIER_PATTERN = /^([A-Z][A-Z0-9_]*)-(\d+)$/i
const PLANE_ISSUE_ROUTE_SEGMENTS = new Set(['issues', 'work-items', 'browse'])

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
    if (issueRouteIndex === -1) {
      return null
    }
    if (isEpicBrowsePath(pathParts, issueRouteIndex)) {
      return null
    }
    const identifier = pathParts.find(
      (part, index) => index > issueRouteIndex && PLANE_IDENTIFIER_PATTERN.test(part)
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

function isEpicBrowsePath(pathParts: string[], browseIndex: number): boolean {
  return (
    pathParts[browseIndex] === 'browse' &&
    pathParts.slice(browseIndex + 1).some((part) => ['epic', 'epics'].includes(part.toLowerCase()))
  )
}

function parsePlaneIdentifier(value: string): PlaneIssueLink | null {
  const match = PLANE_IDENTIFIER_PATTERN.exec(value)
  if (!match) {
    return null
  }
  const projectIdentifier = match[1].toUpperCase()
  const sequenceId = Number(match[2])
  if (!Number.isSafeInteger(sequenceId) || sequenceId <= 0) {
    return null
  }
  return {
    projectIdentifier,
    sequenceId,
    identifier: `${projectIdentifier}-${sequenceId}`
  }
}
