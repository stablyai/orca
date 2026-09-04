import type { PlaneWorkItem, PlaneWorkspace } from './plane-types'

/**
 * Plane exposes a work item under two routes: the shareable `/browse/PROJ-123/`
 * link and the in-app `/projects/<uuid>/issues/<uuid>` route the address bar
 * shows. Both are pasted, so both parse; only the first carries a key.
 */
export type ParsedPlaneWorkItemUrl = {
  workspaceSlug: string
  workItemKey: string | null
  projectId: string | null
  workItemId: string | null
  origin: string
  /** Sub-path a self-hosted instance is mounted under; '' when at the root. */
  basePath: string
}

export const PLANE_WORK_ITEM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/

const PLANE_CLOUD_HOST = 'plane.so'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BROWSE_PATH_PATTERN = /^(.*)\/([^/]+)\/browse\/([^/]+)\/?$/
const PROJECT_ISSUE_PATH_PATTERN = /^(.*)\/([^/]+)\/projects\/([^/]+)\/issues\/([^/]+)\/?$/

export function parsePlaneWorkItemUrl(value: string): ParsedPlaneWorkItemUrl | null {
  const url = safeUrl(value)
  if (!url) {
    return null
  }

  const browse = url.pathname.match(BROWSE_PATH_PATTERN)
  if (browse && PLANE_WORK_ITEM_KEY_PATTERN.test(browse[3])) {
    return {
      workspaceSlug: browse[2],
      workItemKey: browse[3].toUpperCase(),
      projectId: null,
      workItemId: null,
      origin: url.origin.toLowerCase(),
      basePath: normalizeBasePath(browse[1])
    }
  }

  const detail = url.pathname.match(PROJECT_ISSUE_PATH_PATTERN)
  if (detail && UUID_PATTERN.test(detail[3]) && UUID_PATTERN.test(detail[4])) {
    return {
      workspaceSlug: detail[2],
      workItemKey: null,
      projectId: detail[3].toLowerCase(),
      workItemId: detail[4].toLowerCase(),
      origin: url.origin.toLowerCase(),
      basePath: normalizeBasePath(detail[1])
    }
  }

  return null
}

export function isPlaneWorkItemUrl(value: string): boolean {
  return parsePlaneWorkItemUrl(value) !== null
}

/**
 * A self-hosted Plane `/browse/PROJ-1` path is indistinguishable from a
 * self-hosted Jira one, so provider sniffing from a bare URL is only safe for
 * the cloud host. Self-hosted items are identified by the stored identifier or
 * by matching a connected workspace.
 */
export function isPlaneCloudWorkItemUrl(value: string): boolean {
  const parsed = parsePlaneWorkItemUrl(value)
  if (!parsed) {
    return false
  }
  const hostname = safeUrl(value)?.hostname.toLowerCase() ?? ''
  return hostname === PLANE_CLOUD_HOST || hostname.endsWith(`.${PLANE_CLOUD_HOST}`)
}

export function buildPlaneWorkItemUrl(
  workspace: Pick<PlaneWorkspace, 'appUrl' | 'slug'>,
  workItemKey: string
): string {
  const appUrl = workspace.appUrl.replace(/\/+$/, '')
  return `${appUrl}/${encodeURIComponent(workspace.slug)}/browse/${encodeURIComponent(workItemKey)}/`
}

export function getMatchingPlaneWorkspaces(
  parsed: ParsedPlaneWorkItemUrl,
  workspaces: readonly PlaneWorkspace[]
): PlaneWorkspace[] {
  return workspaces.filter((workspace) => {
    const identity = getPlaneWorkspaceIdentity(workspace.appUrl)
    return (
      identity !== null &&
      identity.origin === parsed.origin &&
      identity.basePath === parsed.basePath &&
      workspace.slug.toLowerCase() === parsed.workspaceSlug.toLowerCase()
    )
  })
}

/**
 * Guards against a lookup in the wrong workspace returning a same-key item:
 * the resolved work item must round-trip back to the URL that requested it.
 */
export function isResolvedPlaneWorkItemMatch(
  parsed: ParsedPlaneWorkItemUrl,
  workspace: PlaneWorkspace,
  workItem: PlaneWorkItem
): boolean {
  // Plane discriminates workspaces by path segment, not origin, so two
  // workspaces on one host can each own a PROJ-123. The requested url must
  // belong to this workspace before its key is trusted.
  if (getMatchingPlaneWorkspaces(parsed, [workspace]).length !== 1) {
    return false
  }
  if (workItem.workspaceId !== undefined && workItem.workspaceId !== workspace.id) {
    return false
  }
  if (parsed.workItemKey && workItem.key.toUpperCase() !== parsed.workItemKey) {
    return false
  }
  if (parsed.workItemId && workItem.id.toLowerCase() !== parsed.workItemId) {
    return false
  }
  const canonical = parsePlaneWorkItemUrl(workItem.url)
  return canonical !== null && getMatchingPlaneWorkspaces(canonical, [workspace]).length === 1
}

function getPlaneWorkspaceIdentity(
  value: string
): Pick<ParsedPlaneWorkItemUrl, 'origin' | 'basePath'> | null {
  const url = safeUrl(value)
  if (!url || url.search.length > 0 || url.hash.length > 0) {
    return null
  }
  return { origin: url.origin.toLowerCase(), basePath: normalizeBasePath(url.pathname) }
}

function safeUrl(value: string): URL | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  // Credentials in the URL would travel into stored workspace metadata.
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return null
  }
  return url
}

function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/g, '')
  return trimmed === '/' ? '' : trimmed
}
