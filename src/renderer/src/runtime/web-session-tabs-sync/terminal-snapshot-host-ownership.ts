import { indexTerminalTabExecutionHosts } from '@/lib/terminal-tab-execution-hosts'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import {
  toWebTerminalSurfaceTabId,
  toScopedWebTerminalSurfaceTabId
} from '../../../../shared/terminal-surface-id'
import { isTerminalTabOwnedByAnotherHost } from './terminal-surfaces'
import type { WebSessionTabsSyncState } from './state'
import {
  createTerminalTabOwnerIndex,
  getTerminalTabOwnerWorktreeIds
} from '../../store/slices/terminal-tab-owner-index'

const canonicalTerminalOwners = createTerminalTabOwnerIndex<Tab>((tab) =>
  tab.contentType === 'terminal' ? [tab.id, tab.entityId] : []
)

export function indexTerminalSnapshotHosts(
  state: WebSessionTabsSyncState,
  worktreeId: string
): ReadonlyMap<string, ExecutionHostId | null> {
  return indexTerminalTabExecutionHosts(state.unifiedTabsByWorktree[worktreeId] ?? [])
}

/** Keep ordinary IDs stable; namespace collisions before writing global pane records. */
export function resolveTerminalSnapshotLocalIds(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  terminalHostById: ReadonlyMap<string, ExecutionHostId | null>
): ReadonlyMap<string, string> {
  const localIds = new Map<string, string>()
  const currentRows = new Map(
    (state.tabsByWorktree[snapshot.worktree] ?? []).map((tab) => [tab.id, tab])
  )
  const conflicts = (id: string): boolean => {
    if (
      isTerminalTabOwnedByAnotherHost(
        currentRows.get(id) ?? { ptyId: null },
        environmentId,
        terminalHostById.get(id)
      )
    ) {
      return true
    }
    return [
      ...(getTerminalTabOwnerWorktreeIds(state.tabsByWorktree, id) ?? []),
      ...(canonicalTerminalOwners.getOwnerWorktreeIds(state.unifiedTabsByWorktree, id) ?? [])
    ].some((worktreeId) => worktreeId !== snapshot.worktree)
  }
  for (const surface of snapshot.tabs) {
    if (surface.type !== 'terminal' || localIds.has(surface.parentTabId)) {
      continue
    }
    const ordinaryId = toWebTerminalSurfaceTabId(surface.parentTabId)
    const scopedId = toScopedWebTerminalSurfaceTabId(
      surface.parentTabId,
      environmentId,
      snapshot.worktree
    )
    const scopedAlreadyExists = terminalHostById.has(scopedId) || currentRows.has(scopedId)
    localIds.set(
      surface.parentTabId,
      scopedAlreadyExists || conflicts(ordinaryId) || conflicts(surface.parentTabId)
        ? scopedId
        : ordinaryId
    )
  }
  return localIds
}
