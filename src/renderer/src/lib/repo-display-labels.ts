import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

type RepoDisplayLabelItem = {
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

/** Compact host role for project headers when the same name exists on multiple hosts. */
export function getRepoDisplayHostRole(
  item: Pick<RepoDisplayLabelItem, 'connectionId' | 'executionHostId'>
): 'Local' | 'SSH' | 'Remote' {
  const parsed = parseExecutionHostId(getRepoExecutionHostId(item))
  if (!parsed || parsed.kind === 'local') {
    return 'Local'
  }
  if (parsed.kind === 'ssh') {
    return 'SSH'
  }
  return 'Remote'
}

export function getRepoDisplayLabelsByPath(
  items: readonly RepoDisplayLabelItem[]
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
    // Why: same path+name across local/remote cannot be disambiguated by parent
    // path alone (#13221). Path-expand within each host role first so two Local
    // apis stay payments/api vs billing/api, then append Local/SSH/Remote when
    // the collision group spans more than one role.
    const hostRoles = new Set(collidingItems.map((item) => getRepoDisplayHostRole(item)))
    const appendHostRole = hostRoles.size > 1
    const itemsByRole = new Map<string, RepoDisplayLabelItem[]>()
    for (const item of collidingItems) {
      const role = getRepoDisplayHostRole(item)
      const group = itemsByRole.get(role) ?? []
      group.push(item)
      itemsByRole.set(role, group)
    }
    for (const [role, roleItems] of itemsByRole) {
      const maxDepth = Math.max(...roleItems.map((item) => normalizePathSegments(item.path).length))
      let depth = 1
      let nextLabels = roleItems.map((item) => labelForDepth(item, depth))
      while (depth < maxDepth && hasDuplicateLabels(nextLabels)) {
        depth += 1
        nextLabels = roleItems.map((item) => labelForDepth(item, depth))
      }
      roleItems.forEach((item, index) => {
        const base = nextLabels[index] ?? item.displayName
        labels.set(getRepoDisplayLabelKey(item), appendHostRole ? `${base} · ${role}` : base)
      })
    }
  }
  return labels
}
