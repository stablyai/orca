import type { AppState } from '@/store/types'
import type { Tab } from '../../../shared/tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import { defaultAgentChatLabel } from '../../../shared/agent-session/agent-session-chat-label'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { resolveUnifiedTabCreatePlacement } from '@/store/slices/tabs/tabs-create-placement'
import type { StructuredLaunchSurfaceAddress } from './structured-agent-session-launch-record'
import { readStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'
import { getStructuredAgentSessionLaunchOwner } from './structured-agent-session-launch-registry'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { holdFrameDrawnProvisionalChatTab } from './desktop-created-server-tabs'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import {
  openAgentSessionTabThroughLayoutOwner,
  type OpenedAgentSessionTab
} from './structured-agent-session-tab-open-through-layout-owner'

export function findStructuredLaunchTab(
  args: {
    worktreeId: string
    sessionId: string
    executionHostId: ExecutionHostId
  },
  get: () => AppState
): Tab | null {
  const owner = getStructuredAgentSessionLaunchOwner(args.sessionId)
  const tabs = get().unifiedTabsByWorktree[args.worktreeId]
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
  targetGroupId: string | undefined,
  get: () => AppState
): StructuredLaunchSurfaceAddress {
  const state = get()
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

export function openStructuredAgentSessionProvisionalTab(
  args: {
    worktreeId: string
    executionHostId: ExecutionHostId
    sessionId: string
    agent: TuiAgent
    targetGroupId?: string
    /** The tab the chat opens right after, in that tab's group. */
    afterTabId?: string
    activate?: boolean
  },
  get: () => AppState
): OpenedAgentSessionTab {
  const state = get()
  const existing = findStructuredLaunchTab(args, get)
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
    const target = structuredAgentSessionTargetForHost(args.executionHostId)
    holdFrameDrawnProvisionalChatTab(target, args.worktreeId, tab.id)
    if (args.activate !== false) {
      state.setActiveTabType('agent-session', args.worktreeId)
    }
    return tab
  }
  // Switch point: main opens the chat's tab and its frame draws it.
  const sent = ORCA_LAYOUT_OWNER_IS_MAIN
    ? openAgentSessionTabThroughLayoutOwner(
        {
          worktreeId: args.worktreeId,
          executionHostId: args.executionHostId,
          sessionId: args.sessionId,
          agent: args.agent,
          ...(targetGroupId ? { targetGroupId } : {}),
          // A reserved slot names where the chat goes: after the tab before it.
          ...(args.afterTabId
            ? { afterTabId: args.afterTabId }
            : slotAnchor(address, args.worktreeId, get)),
          activate: args.activate !== false,
          drawHere
        },
        get
      )
    : null
  return sent ?? drawHere()
}

/** The last tab still before a reserved chat slot, which main places the chat after. */
function slotAnchor(
  address: StructuredLaunchSurfaceAddress | undefined,
  worktreeId: string,
  get: () => AppState
): { afterTabId?: string } {
  if (address?.worktreeId !== worktreeId) {
    return {}
  }
  const tabs = get().unifiedTabsByWorktree[worktreeId] ?? []
  const afterTabId = address.precedingTabIds.findLast((id) => tabs.some((tab) => tab.id === id))
  return afterTabId ? { afterTabId } : {}
}
