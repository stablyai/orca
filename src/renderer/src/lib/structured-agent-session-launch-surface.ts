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
import { defaultAgentChatLabel } from '../../../shared/agent-session-chat-label'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { useAppStore } from '@/store'
import { resolveUnifiedTabCreatePlacement } from '@/store/slices/tabs/tabs-create-placement'
import type { StructuredLaunchSurfaceAddress } from './structured-agent-session-launch-record'
import {
  readStructuredAgentLaunchRecord,
  readStructuredAgentLaunchRecords,
  writeStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import {
  getStructuredAgentSessionLaunchOwner,
  getStructuredLaunchStateBySessionId
} from './structured-agent-session-launch-registry'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import {
  openAgentSessionTabThroughLayoutOwner,
  type OpenedAgentSessionTab
} from './structured-agent-session-tab-open-through-layout-owner'
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

export function findStructuredLaunchTab(args: {
  worktreeId: string
  sessionId: string
  executionHostId: ExecutionHostId
}): Tab | null {
  const owner = getStructuredAgentSessionLaunchOwner(args.sessionId)
  const tabs = useAppStore.getState().unifiedTabsByWorktree[args.worktreeId]
  return (
    tabs?.find(
      (tab) =>
        tab.worktreeId === args.worktreeId &&
        tab.contentType === 'agent-session' &&
        tab.entityId === args.sessionId &&
        (tab.executionHostId ?? owner) === args.executionHostId
    ) ?? null
  )
}

export function captureStructuredLaunchSurfaceAddress(
  worktreeId: string,
  targetGroupId?: string
): StructuredLaunchSurfaceAddress {
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const placement = resolveUnifiedTabCreatePlacement({
    groups,
    tabs: state.unifiedTabsByWorktree[worktreeId] ?? [],
    activeGroupId: state.activeGroupIdByWorktree[worktreeId],
    targetGroupId,
    lookupWorktrees: () => []
  })
  return {
    worktreeId,
    targetGroupId: placement.groupId,
    precedingTabIds: groups.find((group) => group.id === placement.groupId)?.tabOrder ?? []
  }
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

export function openStructuredAgentSessionProvisionalTab(args: {
  worktreeId: string
  executionHostId: ExecutionHostId
  sessionId: string
  agent: TuiAgent
  targetGroupId?: string
  /** The tab the chat opens right after, in that tab's group. */
  afterTabId?: string
  activate?: boolean
}): OpenedAgentSessionTab {
  const state = useAppStore.getState()
  const existing = findStructuredLaunchTab(args)
  if (existing) {
    if (args.activate !== false) {
      state.focusGroup(args.worktreeId, existing.groupId)
      state.activateTab(existing.id, { worktreeId: args.worktreeId })
      state.setActiveTabType('agent-session', args.worktreeId)
    }
    return existing
  }
  const tabId = structuredAgentSessionTabId(args.sessionId)
  const record = readStructuredAgentLaunchRecord(args.sessionId)
  const address =
    record?.executionHostId === args.executionHostId ? record.surfaceAddress : undefined
  const group = state.groupsByWorktree?.[args.worktreeId]?.find((entry) =>
    entry.tabOrder.includes(tabId)
  )
  const targetGroupId =
    group?.id ??
    (address?.worktreeId === args.worktreeId ? address.targetGroupId : args.targetGroupId)
  const drawHere = (): Tab => {
    const tab = state.createUnifiedTab(args.worktreeId, 'agent-session', {
      id: tabId,
      entityId: args.sessionId,
      executionHostId: args.executionHostId,
      agentSessionAgent: args.agent,
      label: defaultAgentChatLabel(args.agent),
      targetGroupId,
      ...(args.afterTabId ? { afterTabId: args.afterTabId } : {}),
      activate: args.activate !== false
    })
    if (args.activate !== false) {
      state.setActiveTabType('agent-session', args.worktreeId)
    }
    return tab
  }
  // Switch point: main opens the chat's tab and its frame draws it.
  const sent = ORCA_LAYOUT_OWNER_IS_MAIN
    ? openAgentSessionTabThroughLayoutOwner({
        worktreeId: args.worktreeId,
        executionHostId: args.executionHostId,
        sessionId: args.sessionId,
        agent: args.agent,
        ...(targetGroupId ? { targetGroupId } : {}),
        // A reserved slot names where the chat goes: after the tab before it.
        ...(args.afterTabId
          ? { afterTabId: args.afterTabId }
          : slotAnchor(address, args.worktreeId)),
        activate: args.activate !== false,
        drawHere
      })
    : null
  return sent ?? drawHere()
}

/** The last tab still before a reserved chat slot, which main places the chat after. */
function slotAnchor(
  address: StructuredLaunchSurfaceAddress | undefined,
  worktreeId: string
): { afterTabId?: string } {
  if (address?.worktreeId !== worktreeId) {
    return {}
  }
  const tabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
  const afterTabId = address.precedingTabIds.findLast((id) => tabs.some((tab) => tab.id === id))
  return afterTabId ? { afterTabId } : {}
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
