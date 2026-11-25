import type { CrossStoreParentRef, WorkspaceLineage } from '../lineage-types'
import { isCrossStoreWorkspaceLineage } from './cross-store-lineage-records'
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
> &
  Partial<Pick<PersistedState, 'crossStoreLineageByChildKey'>>

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

/** Marks a child before its saved parent evidence is erased or replaced, when that evidence is a
 *  folder edge: its same-store folder row, or its cross-store link (saved by the child's store
 *  only) to a folder in another store, or one this build cannot read. `keepCrossStoreParent` is the
 *  parent a cross-store rewrite saves again, which leaves that link's evidence in place. */
export function preserveFolderLineageUncertainty(
  state: State,
  childKey: string,
  keepCrossStoreParent?: CrossStoreParentRef
): void {
  const rows: Record<string, WorkspaceLineage | undefined> = state.workspaceLineageByChildKey ?? {}
  if (
    rows[childKey]?.parentWorkspaceKey?.startsWith('folder:') ||
    crossStoreFolderEvidence(state.crossStoreLineageByChildKey, childKey, keepCrossStoreParent)
  ) {
    markLineageUncertainty(state, childKey)
  }
}

function crossStoreFolderEvidence(
  saved: Readonly<Record<string, unknown>> | undefined,
  childKey: string,
  keep: CrossStoreParentRef | undefined
): boolean {
  if (!saved || !Object.hasOwn(saved, childKey)) {
    return false
  }
  const link = saved[childKey]
  if (!isCrossStoreWorkspaceLineage(link) || link.childWorkspaceKey !== childKey) {
    return true
  }
  return (
    link.parent.workspaceKey.startsWith('folder:') &&
    !(
      keep &&
      keep.installationId === link.parent.installationId &&
      keep.workspaceKey === link.parent.workspaceKey
    )
  )
}

/** Marks a child whose folder-parent evidence is about to go, wherever that evidence was saved: the
 *  host is the child's single owning host, or null (every host) when that is not certain. */
export function markLineageUncertainty(
  state: Pick<State, 'workspaceLineageUncertaintyByChild' | 'worktreeMeta' | 'repos'>,
  childKey: string
): void {
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
