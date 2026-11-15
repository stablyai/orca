import type { WorkspaceLineage } from '../lineage-types'
import type { PersistedState } from '../../orca-profiles/persisted-state-types'
import { parseWorkspaceKey } from '../../workspace/identity/workspace-scope'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../execution-host/execution-host'
import { getRepoIdFromWorktreeId } from '../id'

export const UNKNOWN_LINEAGE_KEY = JSON.stringify([null, null])
export type LineageUncertainty = Record<string, true>
export const LINEAGE_SCAN_ROW_LIMIT = 5000
type State = Pick<
  PersistedState,
  'workspaceLineageByChildKey' | 'workspaceLineageUncertaintyByChild' | 'worktreeMeta' | 'repos'
>

export function isLineageUncertaintyMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function decodeLineageUncertaintyKey(
  key: string
):
  | { host: string | null; child: string | null; node: string | null; project?: string }
  | undefined {
  try {
    const tuple: unknown = JSON.parse(key)
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      (tuple[0] !== null &&
        (typeof tuple[0] !== 'string' || parseExecutionHostId(tuple[0])?.id !== tuple[0])) ||
      (tuple[1] !== null && (typeof tuple[1] !== 'string' || !parseWorkspaceKey(tuple[1])))
    ) {
      return undefined
    }
    const child: string | null = tuple[1]
    const node = child?.startsWith('worktree:') ? child.slice(9) : child
    const project = node && !node.startsWith('folder:') ? getRepoIdFromWorktreeId(node) : undefined
    return {
      host: tuple[0],
      child,
      node,
      project: project && node && project.length < node.length ? project : undefined
    }
  } catch {
    return undefined
  }
}

export function normalizeLineageUncertainty(
  value: unknown,
  onInvalid?: () => void
): LineageUncertainty {
  if (value === undefined) {
    return {}
  }
  if (!isLineageUncertaintyMap(value)) {
    onInvalid?.()
    return { [UNKNOWN_LINEAGE_KEY]: true }
  }
  const result: LineageUncertainty = {}
  for (const key in value) {
    if (decodeLineageUncertaintyKey(key) && value[key] === true) {
      result[key] = true
    } else {
      result[UNKNOWN_LINEAGE_KEY] = true
      onInvalid?.()
    }
  }
  return result
}

/** Cache immutable key syntax only; host/catalog, flags and instance evidence stay live. */
export class LineageUncertaintyKeyIndex {
  private readonly parsed = new Map<string, ReturnType<typeof decodeLineageUncertaintyKey>>()

  decode(key: string): ReturnType<typeof decodeLineageUncertaintyKey> {
    const cached = this.parsed.get(key)
    if (cached !== undefined || this.parsed.has(key)) {
      return cached
    }
    const decoded = decodeLineageUncertaintyKey(key)
    this.parsed.set(key, decoded)
    if (this.parsed.size > LINEAGE_SCAN_ROW_LIMIT) {
      const oldest = this.parsed.keys().next().value
      if (oldest !== undefined) {
        this.parsed.delete(oldest)
      }
    }
    return decoded
  }
}

export function preserveFolderLineageUncertainty(state: State, childKey: string): void {
  const rows: Record<string, WorkspaceLineage | undefined> = state.workspaceLineageByChildKey ?? {}
  const row = rows[childKey]
  if (!row?.parentWorkspaceKey?.startsWith('folder:')) {
    return
  }
  const markers = (state.workspaceLineageUncertaintyByChild ??= {})
  const child = parseWorkspaceKey(childKey)
  if (!child || child.type !== 'worktree') {
    markers[UNKNOWN_LINEAGE_KEY] = true
    return
  }
  const repos = state.repos.filter((repo) => repo.id === getRepoIdFromWorktreeId(child.worktreeId))
  const owners = new Set(repos.map(getRepoExecutionHostId))
  const metaHost = state.worktreeMeta[child.worktreeId]?.hostId
  const host = owners.size === 1 && (!metaHost || owners.has(metaHost)) ? [...owners][0]! : null
  markers[JSON.stringify([host, childKey])] = true
}
