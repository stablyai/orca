import { useAppStore } from '@/store'
import { findReusableRightSplitGroupId } from './emulator-right-split-target'
import { cancelPendingSimulatorPaneShutdown } from './simulator-pane-shutdown-scheduler'
import { shouldShutdownSimulatorForPaneUnmountFromTabs } from './simulator-tab-shutdown'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from './browser-uuid'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import {
  findAmbiguousWorktreeIds,
  getActiveExecutionHostIdForWorktree,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'
import { isExecutionHostAliasForWorktree } from './worktree-execution-host-alias'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import {
  frameDrawnServerOfSimulatorTab,
  noteSimulatorTabCreatedHere,
  openingSimulatorTabId,
  openSimulatorTabThroughLayoutOwner
} from './simulator-tab-layout-owner'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

type EnsureSimulatorTabOptions = {
  targetGroupId?: string
  placement?: 'activeGroup' | 'rightSplit'
  surfacePane?: boolean
  executionHostId?: ExecutionHostId
}

type ExistingSimulatorTab = {
  id: string
  groupId: string
  contentType: string
}

function getSimulatorWorktrees(state: ReturnType<typeof useAppStore.getState>, worktreeId: string) {
  return [
    ...(state.allWorktrees?.() ?? []),
    ...(selectFolderWorkspaces(state) ?? []).map(folderWorkspaceToWorktree)
  ].filter((worktree) => worktree.id === worktreeId)
}

function resolveSimulatorExecutionHostId(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string,
  requestedHostId?: ExecutionHostId
): ExecutionHostId | undefined {
  const worktrees = getSimulatorWorktrees(state, worktreeId)
  const preferredHostId = requestedHostId ?? getActiveExecutionHostIdForWorktree(state, worktreeId)
  if (
    preferredHostId &&
    worktrees.some((worktree) => isExecutionHostAliasForWorktree(preferredHostId, worktree))
  ) {
    return preferredHostId
  }
  if (requestedHostId) {
    return requestedHostId
  }
  return worktrees.length === 1 ? (worktrees[0].hostId ?? LOCAL_EXECUTION_HOST_ID) : requestedHostId
}

export function getSimulatorTabForWorktree(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): ExistingSimulatorTab | null {
  const state = useAppStore.getState()
  const worktrees = getSimulatorWorktrees(state, worktreeId)
  const activeExecutionHostId =
    executionHostId ?? getActiveExecutionHostIdForWorktree(state, worktreeId)
  const activeWorktree = worktrees.find((worktree) =>
    activeExecutionHostId ? isExecutionHostAliasForWorktree(activeExecutionHostId, worktree) : false
  )
  const simulatorTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'simulator'
  )
  if (worktrees.length === 0) {
    if (executionHostId) {
      return simulatorTabs.find((tab) => tab.executionHostId === executionHostId) ?? null
    }
    return simulatorTabs[0] ?? null
  }
  if (executionHostId && !activeWorktree) {
    return simulatorTabs.find((tab) => tab.executionHostId === executionHostId) ?? null
  }
  const target = activeWorktree ?? (worktrees.length === 1 ? worktrees[0] : null)
  if (!target) {
    return null
  }
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(worktrees)
  return (
    simulatorTabs.find((tab) => isUnifiedTabOwnedByWorktree(tab, target, ambiguousWorktreeIds)) ??
    null
  )
}

export function ensureSimulatorTab(
  worktreeId: string,
  options?: EnsureSimulatorTabOptions
): string | null {
  const store = useAppStore.getState()
  if (store.settings?.mobileEmulatorEnabled === false) {
    return null
  }
  const sourceGroupId =
    options?.targetGroupId ??
    store.activeGroupIdByWorktree[worktreeId] ??
    store.groupsByWorktree[worktreeId]?.[0]?.id ??
    // Main's frames draw no empty group: a layout-owner build opens into the workspace's root one.
    (ORCA_LAYOUT_OWNER_IS_MAIN ? store.ensureWorktreeRootGroup(worktreeId) : undefined)
  if (!sourceGroupId) {
    return null
  }
  cancelPendingSimulatorPaneShutdown(worktreeId)

  const executionHostId = resolveSimulatorExecutionHostId(
    store,
    worktreeId,
    options?.executionHostId
  )
  const existing = getSimulatorTabForWorktree(worktreeId, executionHostId)
  const shouldSurface = options?.surfacePane ?? true
  if (existing) {
    if (shouldSurface && store.activeWorktreeId === worktreeId) {
      store.activateTab(existing.id)
      store.focusGroup(worktreeId, existing.groupId)
      store.setActiveTabType('simulator', worktreeId)
    }
    return existing.id
  }

  const label = translate('auto.lib.ensure.simulator.tab.372d21d428', 'Mobile Emulator')
  const reusableRightGroupId =
    options?.placement === 'rightSplit' && shouldSurface
      ? findReusableRightSplitGroupId(store.layoutByWorktree[worktreeId], sourceGroupId)
      : null
  // Paired-server frame groups belong to another host; use the group beside which this desktop would split.
  const serverEnvironmentId = ORCA_LAYOUT_OWNER_IS_MAIN
    ? frameDrawnServerOfSimulatorTab(store, worktreeId)
    : null
  const rightSplit =
    options?.placement === 'rightSplit' &&
    shouldSurface &&
    !reusableRightGroupId &&
    !serverEnvironmentId
  const groupId = reusableRightGroupId ?? sourceGroupId
  const drawHere = (tabId?: string): string | null => {
    // Create directly in the split group; create-then-move can persist an intermediate state during HMR.
    const splitTab = rightSplit
      ? store.createUnifiedTabInSplit(
          worktreeId,
          'simulator',
          { sourceGroupId, splitDirection: 'right' },
          { ...(tabId ? { id: tabId } : {}), label, activate: true, ...hostOf(executionHostId) }
        )
      : null
    if (splitTab) {
      return splitTab.id
    }
    const id = tabId ?? createBrowserUuid()
    store.createUnifiedTab(worktreeId, 'simulator', {
      id,
      label,
      targetGroupId: groupId,
      activate: reusableRightGroupId ? true : shouldSurface,
      ...hostOf(executionHostId)
    })
    if (reusableRightGroupId || shouldSurface) {
      surfaceCreatedSimulatorTab(worktreeId, id)
    }
    return id
  }
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    const opening = openingSimulatorTabId(worktreeId)
    if (opening) {
      return opening
    }
    const sent = openSimulatorTabThroughLayoutOwner(store, {
      worktreeId,
      label,
      groupId,
      rightSplit,
      surface: (tabId) => {
        if (shouldSurface) {
          surfaceCreatedSimulatorTab(worktreeId, tabId)
        }
      },
      drawHere
    })
    if (sent) {
      return sent
    }
  }
  const drawnId = drawHere()
  if (drawnId && serverEnvironmentId) {
    noteSimulatorTabCreatedHere(serverEnvironmentId, worktreeId, drawnId)
  }
  return drawnId
}

function hostOf(executionHostId: ExecutionHostId | undefined): {
  executionHostId?: ExecutionHostId
} {
  return executionHostId ? { executionHostId } : {}
}

function surfaceCreatedSimulatorTab(worktreeId: string, tabId: string): void {
  const store = useAppStore.getState()
  store.activateTab(tabId)
  store.setActiveTabType('simulator', worktreeId)
  // Why read by id: placement falls back to the active group when the requested one is gone.
  const groupId = store.getTab(tabId)?.groupId
  if (groupId) {
    store.focusGroup(worktreeId, groupId)
  }
}

export { shouldShutdownSimulatorForPaneUnmountFromTabs }
