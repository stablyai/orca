import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { isHome, type BotHomeOwner } from '../../../../../shared/bots/bot-homes'
import { getFolderWorkspaceWorktree } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { computeAutoCollapseLineageUpdate } from '../../../../../shared/sidebar-list/lineage/auto-collapse-lineage-state'
import { getSidebarLineageParentsByIdentity } from '../../../../../shared/sidebar-list/lineage/worktree-lineage-projection'
import { getWorktreeLineageGroupKey } from '../../../../../shared/sidebar-list/sections/group-keys'
import { getActiveSidebarWorkspaceId } from '../../../../../shared/workspace/identity/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../shared/worktree/types'
import { readBots } from '@/lib/bot-catalog-snapshot'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../workspaces/catalog/workspace-record-fields'
import type { StoreObserverHost } from '../../store-observer-installers'
import type { AppState } from '../../types'
import {
  runtimeStatusSubscriptionsFor,
  type RuntimeStatuses
} from '../runtime-status/views/runtime-status-subscriptions'
import { getIndexedAllWorktrees } from '../worktrees/listing/worktree-catalog-index'
import { selectSidebarLineageParentIdentities } from '../worktrees/metadata/cross-store-lineage-parents'
import { recordCollapsedGroupChanges } from './collapsed-group-toggle'

type AutoCollapseObserverOptions = {
  readStatuses?: () => RuntimeStatuses
  readBotList?: () => readonly BotHomeOwner[]
}

function relevantInputsChanged(state: AppState, previous: AppState): boolean {
  return (
    state.persistedUIReady !== previous.persistedUIReady ||
    state.settings?.startChildWorkspacesCollapsed !==
      previous.settings?.startChildWorkspacesCollapsed ||
    selectWorktreesByRepo(state) !== selectWorktreesByRepo(previous) ||
    state.worktreeLineageById !== previous.worktreeLineageById ||
    state.workspaceLineageByChildKey !== previous.workspaceLineageByChildKey ||
    state.crossStoreLineageByStoreKey !== previous.crossStoreLineageByStoreKey ||
    selectFolderWorkspaces(state) !== selectFolderWorkspaces(previous) ||
    state.collapsedGroups !== previous.collapsedGroups ||
    state.expandedLineageGroups !== previous.expandedLineageGroups ||
    state.ownLineageInstallationId !== previous.ownLineageInstallationId ||
    state.removedRuntimeEnvironmentIds !== previous.removedRuntimeEnvironmentIds
  )
}

function collectNonArchivedRowsByIdentity(
  state: AppState,
  readBotList: () => readonly BotHomeOwner[]
): Map<string, Worktree> {
  const rows = new Map<string, Worktree>()
  for (const worktree of getIndexedAllWorktrees(selectWorktreesByRepo(state))) {
    if (!worktree.isArchived) {
      rows.set(getWorktreeHostIdentity(worktree), worktree)
    }
  }
  const bots = readBotList()
  for (const folder of selectFolderWorkspaces(state) ?? []) {
    // Archived folders and bot homes are excluded from sidebar lineage collapse.
    if (folder.isArchived || isHome(folder, bots)) {
      continue
    }
    const row = getFolderWorkspaceWorktree(folder)
    rows.set(getWorktreeHostIdentity(row), row)
  }
  return rows
}

function collectAncestorLineageKeysForTarget(
  targetId: string,
  targetHostId: ExecutionHostId | null | undefined,
  rows: ReadonlyMap<string, Worktree>,
  parentByIdentity: ReadonlyMap<string, Worktree>,
  protectedKeys: Set<string>
): void {
  const matched: Worktree[] = []
  if (targetHostId) {
    const hostRow = rows.get(getWorktreeHostIdentity({ id: targetId, hostId: targetHostId }))
    if (hostRow) {
      matched.push(hostRow)
    }
    const localUnstampedRow = rows.get(targetId)
    if (localUnstampedRow && !localUnstampedRow.hostId) {
      matched.push(localUnstampedRow)
    }
  } else {
    for (const row of rows.values()) {
      if (row.id === targetId) {
        matched.push(row)
      }
    }
  }
  for (const row of matched) {
    let current: Worktree | undefined = row
    const visited = new Set<string>()
    while (current) {
      const identity = getWorktreeHostIdentity(current)
      if (visited.has(identity)) {
        break
      }
      visited.add(identity)
      const parent = parentByIdentity.get(identity)
      if (!parent) {
        break
      }
      protectedKeys.add(getWorktreeLineageGroupKey(parent))
      current = parent
    }
  }
}

function collectActiveProtectedParentKeys(
  state: AppState,
  rows: ReadonlyMap<string, Worktree>,
  parentByIdentity: ReadonlyMap<string, Worktree>
): Set<string> {
  const protectedKeys = new Set<string>()
  const activeId = getActiveSidebarWorkspaceId(state.activeWorkspaceKey, state.activeWorktreeId)
  if (activeId) {
    collectAncestorLineageKeysForTarget(
      activeId,
      state.activeWorkspaceExecutionHostId,
      rows,
      parentByIdentity,
      protectedKeys
    )
  }
  if (state.pendingRevealWorktree) {
    collectAncestorLineageKeysForTarget(
      state.pendingRevealWorktree.worktreeId,
      state.pendingRevealWorktree.executionHostId,
      rows,
      parentByIdentity,
      protectedKeys
    )
  }
  return protectedKeys
}

/** Auto-collapses a parent's lineage the first time it gains a child while the setting is on. */
export function installAutoCollapseChildWorkspacesObserver(
  store: StoreObserverHost,
  options: AutoCollapseObserverOptions = {}
): () => void {
  const readStatuses =
    options.readStatuses ?? (() => runtimeStatusSubscriptionsFor(store).readStatuses())
  const readBotList = options.readBotList ?? readBots
  let previousEnabled: boolean | undefined
  let applying = false

  const reconcile = (state: AppState): void => {
    if (applying || !state.persistedUIReady || !state.settings) {
      return
    }
    const enabled = state.settings.startChildWorkspacesCollapsed === true
    if (!enabled) {
      const wasEnabled = previousEnabled === true
      previousEnabled = false
      if (wasEnabled && state.expandedLineageGroups.size > 0) {
        applying = true
        try {
          state.applyLineageCollapseState({ expandedLineageGroups: new Set() })
        } finally {
          applying = false
        }
      }
      return
    }

    const mode = previousEnabled === false ? 'seed-existing' : 'collapse-new'
    previousEnabled = true

    const rows = collectNonArchivedRowsByIdentity(state, readBotList)
    if (rows.size === 0) {
      return
    }
    const parentIdentities = selectSidebarLineageParentIdentities(state, readStatuses())
    const parentByIdentity = getSidebarLineageParentsByIdentity(
      state.worktreeLineageById,
      rows,
      parentIdentities
    )
    if (parentByIdentity.size === 0) {
      return
    }
    const parentKeys = new Set<string>()
    for (const parent of parentByIdentity.values()) {
      parentKeys.add(getWorktreeLineageGroupKey(parent))
    }
    const protectedParentKeys = collectActiveProtectedParentKeys(state, rows, parentByIdentity)
    const update = computeAutoCollapseLineageUpdate({
      parentKeys,
      protectedParentKeys,
      collapsedGroups: state.collapsedGroups,
      expandedLineageGroups: state.expandedLineageGroups,
      mode
    })
    if (!update) {
      return
    }
    applying = true
    try {
      state.applyLineageCollapseState({
        ...(update.collapsedChanged
          ? {
              collapsedGroups: recordCollapsedGroupChanges(
                state.collapsedGroups,
                update.collapsedGroups,
                update.addedCollapsedKeys
              )
            }
          : {}),
        ...(update.expandedChanged ? { expandedLineageGroups: update.expandedLineageGroups } : {})
      })
    } finally {
      applying = false
    }
  }

  reconcile(store.getState())
  return store.subscribe((state, previous) => {
    if (!relevantInputsChanged(state, previous)) {
      return
    }
    reconcile(state)
  })
}
