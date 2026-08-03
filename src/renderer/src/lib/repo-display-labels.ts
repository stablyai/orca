import {
  getExecutionHostLabel,
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host'

/** User-facing host names keyed by execution-host id; see useExecutionHostDisplayLabels. */
type HostLabelLookup = ReadonlyMap<string, string>

export type RepoDisplayLabelItem = {
  path: string
  displayName: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}

// Why: two repos can share the same absolute path across hosts (e.g. a local
// /Users/alice and an SSH host's /Users/alice). Keying labels by raw path alone
// lets one repo's label overwrite the other's, so scope the key by execution
// host. getRepoExecutionHostId returns 'local' for local repos and falls back to
// the connectionId (ssh:<id>) for SSH folder-repos that leave executionHostId unset.
export function getRepoDisplayLabelKey(
  item: Pick<RepoDisplayLabelItem, 'path' | 'connectionId' | 'executionHostId'>
): string {
  return `${getRepoExecutionHostId(item)}::${item.path}`
}

function normalizePathSegments(path: string): string[] {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '').split('/').filter(Boolean)
}

function labelForDepth(item: RepoDisplayLabelItem, depth: number): string {
  const segments = normalizePathSegments(item.path)
  const suffix = segments.slice(Math.max(0, segments.length - depth))
  if (suffix.length === 0) {
    return item.displayName
  }
  suffix[suffix.length - 1] = item.displayName
  return suffix.join('/')
}

function hasDuplicateLabels(labels: readonly string[]): boolean {
  return new Set(labels).size !== labels.length
}

// Why: the local host label is hardcoded English in shared/, so only remote
// hosts are safe to render here. Remote ids are generated ('ssh:ssh-1754-a1b2'),
// so the caller's lookup of the user's host name is what makes this readable.
function hostQualifier(
  item: RepoDisplayLabelItem,
  hostLabelById: HostLabelLookup | undefined
): string {
  const hostId = getRepoExecutionHostId(item)
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return ''
  }
  return ` (${hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)})`
}

// Why: byte-identical paths on different hosts can never be split by adding
// parent segments, so name the host for the entries that still tie.
function qualifyRemainingTiesByHost(
  items: readonly RepoDisplayLabelItem[],
  labels: readonly string[],
  hostLabelById: HostLabelLookup | undefined
): string[] {
  if (!hasDuplicateLabels(labels)) {
    return [...labels]
  }
  const counts = new Map<string, number>()
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return labels.map((label, index) => {
    const item = items[index]
    return item && (counts.get(label) ?? 0) > 1
      ? `${label}${hostQualifier(item, hostLabelById)}`
      : label
  })
}

export function getRepoDisplayLabelsByPath(
  items: readonly RepoDisplayLabelItem[],
  hostLabelById?: HostLabelLookup
): Map<string, string> {
  const labels = new Map<string, string>()
  const itemsByName = new Map<string, RepoDisplayLabelItem[]>()

  for (const item of items) {
    const displayName = item.displayName || item.path
    labels.set(getRepoDisplayLabelKey(item), displayName)
    const colliding = itemsByName.get(displayName) ?? []
    colliding.push({ ...item, displayName })
    itemsByName.set(displayName, colliding)
  }

  for (const collidingItems of itemsByName.values()) {
    if (collidingItems.length < 2) {
      continue
    }
    // Why: drive the expansion off distinct paths only — cross-host repos sharing
    // one path can never be separated by depth and would otherwise drag every
    // label in the group out to its full path before the host qualifier runs.
    const itemsByPath = new Map<string, RepoDisplayLabelItem>()
    for (const item of collidingItems) {
      const path = normalizePathSegments(item.path).join('/')
      if (!itemsByPath.has(path)) {
        itemsByPath.set(path, item)
      }
    }
    const distinctItems = [...itemsByPath.values()]
    const maxDepth = Math.max(
      ...distinctItems.map((item) => normalizePathSegments(item.path).length)
    )
    let depth = 1
    while (
      depth < maxDepth &&
      hasDuplicateLabels(distinctItems.map((i) => labelForDepth(i, depth)))
    ) {
      depth += 1
    }
    const nextLabels = collidingItems.map((item) => labelForDepth(item, depth))
    const finalLabels = qualifyRemainingTiesByHost(collidingItems, nextLabels, hostLabelById)
    collidingItems.forEach((item, index) => {
      labels.set(getRepoDisplayLabelKey(item), finalLabels[index] ?? item.displayName)
    })
  }

  return labels
}
