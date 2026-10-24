import {
  findIndexedProjectGroupOwner,
  findIndexedRepoOwner,
  findIndexedWorktreeOwner,
  getCatalogOwnerHostId
} from './worktree-runtime-owner-index'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import type { Tab } from '../../../shared/tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { useAppStore } from '@/store'
import type { StructuredLaunchSurfaceAddress } from './structured-agent-session-launch-record'
import {
  readStructuredAgentLaunchRecords,
  writeStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import {
  getStructuredAgentSessionLaunchOwner,
  getStructuredLaunchStateBySessionId
} from './structured-agent-session-launch-registry'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'
import type { OpenedAgentSessionTab } from './structured-agent-session-tab-open-through-layout-owner'
import {
  findStructuredLaunchTab as findProvisionalLaunchTab,
  captureStructuredLaunchSurfaceAddress as captureProvisionalSurfaceAddress,
  openStructuredAgentSessionProvisionalTab as openProvisionalSessionTab
} from './structured-agent-session-provisional-surface'
import {
  clearWebSessionFocusIntentIfMatches,
  peekWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-focus-intent'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

type LaunchSurface = {
  sessionId: string
  executionHostId: ExecutionHostId
  agent: TuiAgent
  surfaceAddress?: StructuredLaunchSurfaceAddress
}

export function findStructuredLaunchTab(
  args: Parameters<typeof findProvisionalLaunchTab>[0]
): Tab | null {
  return findProvisionalLaunchTab(args, useAppStore.getState)
}

export function captureStructuredLaunchSurfaceAddress(
  worktreeId: string,
  targetGroupId?: string
): StructuredLaunchSurfaceAddress {
  return captureProvisionalSurfaceAddress(worktreeId, targetGroupId, useAppStore.getState)
}

let stopTrackingSlots: (() => void) | undefined

export function stopStructuredLaunchSlotTracking(): void {
  stopTrackingSlots?.()
  stopTrackingSlots = undefined
}

function trackSlotAddresses(): void {
  stopTrackingSlots ??= useAppStore.subscribe((state, previous) => {
    if (state.groupsByWorktree === previous.groupsByWorktree) {
      return
    }
    let hasHiddenSlot = false
    for (const record of readStructuredAgentLaunchRecords()) {
      const address = record.surfaceAddress
      if (!address || record.executionHostId !== 'local') {
        continue
      }
      const tabId = structuredAgentSessionTabId(record.sessionId)
      if (state.unifiedTabsByWorktree[address.worktreeId]?.some((tab) => tab.id === tabId)) {
        continue
      }
      hasHiddenSlot = true
      if (
        state.groupsByWorktree[address.worktreeId] === previous.groupsByWorktree[address.worktreeId]
      ) {
        continue
      }
      const group = state.groupsByWorktree[address.worktreeId]?.find((entry) =>
        entry.tabOrder.includes(tabId)
      )
      const surfaceAddress = {
        worktreeId: address.worktreeId,
        targetGroupId: group?.id,
        precedingTabIds: group ? group.tabOrder.slice(0, group.tabOrder.indexOf(tabId)) : []
      }
      const launch = getStructuredLaunchStateBySessionId(record.sessionId)
      if (launch) {
        launch.intent.surfaceAddress = surfaceAddress
      }
      writeStructuredAgentLaunchRecord({ ...record, surfaceAddress })
    }
    if (!hasHiddenSlot) {
      stopStructuredLaunchSlotTracking()
    }
  })
}

export function reserveStructuredLaunchSlot(launch: LaunchSurface): void {
  const address = launch.surfaceAddress
  if (!address || launch.executionHostId !== 'local') {
    return
  }
  trackSlotAddresses()
  useAppStore.getState().ensureWorktreeRootGroup(address.worktreeId, {
    tabId: structuredAgentSessionTabId(launch.sessionId),
    targetGroupId: address.targetGroupId,
    precedingTabIds: address.precedingTabIds
  })
}

export function openStructuredAgentSessionProvisionalTab(
  args: Parameters<typeof openProvisionalSessionTab>[0]
): OpenedAgentSessionTab {
  return openProvisionalSessionTab(args, useAppStore.getState)
}

export function materializeStructuredLaunchSurface(launch: LaunchSurface, activate?: false): void {
  const address = launch.surfaceAddress
  if (!address || launch.executionHostId !== 'local') {
    return
  }
  const state = useAppStore.getState()
  const owner = structuredAgentSessionFocusOwner({ kind: 'local' })
  const hostTabId = `agent-session:${launch.sessionId}`
  const focus = peekWebSessionFocusIntent(owner, address.worktreeId)
  openStructuredAgentSessionProvisionalTab({
    ...launch,
    worktreeId: address.worktreeId,
    activate:
      activate !== false &&
      focus?.hostTabId === hostTabId &&
      (focus.expectedCurrentLocalTabId === undefined ||
        focus.expectedCurrentLocalTabId ===
          resolveWebSessionVisibleTabId(state, address.worktreeId))
  })
  if (activate !== false) {
    clearWebSessionFocusIntentIfMatches(owner, address.worktreeId, hostTabId)
  }
}

export function restoreStructuredLaunchSurfaces(): void {
  const state = useAppStore.getState()
  const catalog = {
    workspaces: [
      ...state.allWorktrees(),
      ...selectFolderWorkspaces(state).flatMap((workspace) => {
        const group = findIndexedProjectGroupOwner(state.projectGroups, workspace.projectGroupId)
        const host = workspace.executionHostId || workspace.connectionId ? workspace : group
        const owned = host && { ...workspace, executionHostId: getCatalogOwnerHostId(host) }
        return owned ? [folderWorkspaceToWorktree(owned)] : []
      })
    ]
  }
  for (const record of readStructuredAgentLaunchRecords()) {
    if (
      record.executionHostId !== 'local' ||
      record.lifecycle !== 'visibility-unknown' ||
      !record.surfaceAddress
    ) {
      continue
    }
    const workspace = findIndexedWorktreeOwner(catalog, record.surfaceAddress.worktreeId)
    if (!workspace || workspace.runtimeOwnerEnvironmentId?.trim()) {
      continue
    }
    const repo = findIndexedRepoOwner(state.repos, workspace.repoId)
    const host = workspace.hostId ?? (repo ? getCatalogOwnerHostId(repo) : undefined)
    if (host !== getStructuredAgentSessionLaunchOwner(record.sessionId)) {
      continue
    }
    reserveStructuredLaunchSlot(record)
    materializeStructuredLaunchSurface(record, false)
  }
}
