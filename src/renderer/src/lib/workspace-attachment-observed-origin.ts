import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { NotificationWorkspaceOwner } from '../../../shared/notification-source'
import {
  resolveNotificationTabOwner,
  resolveTerminalNotificationOwner
} from '@/attention/notification-subject-owner'
import type { WorkspaceAttachmentOrigin } from '../../../shared/worktree/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { terminalLayoutContainsLeaf } from '../../../shared/workspace-session-pane-ownership'
import type { Tab } from '../../../shared/tab-types'

export type WorkspaceReferenceTerminalContext = {
  kind?: 'terminal'
  tabId: string
  paneKey: string
  ptyId?: string | null
  executionHostId?: ExecutionHostId
}

export type WorkspaceReferenceAgentSessionContext = { kind: 'agent-session'; tabId: string }

export type WorkspaceReferenceObservationContext =
  | WorkspaceReferenceTerminalContext
  | WorkspaceReferenceAgentSessionContext

type ObservationState = Parameters<typeof resolveTerminalNotificationOwner>[0] &
  Pick<AppState, 'tabsByWorktree' | 'agentStatusByPaneKey' | 'terminalLayoutsByTabId'>

function findAgentSessionTab(
  state: Partial<Pick<AppState, 'unifiedTabsByWorktree'>>,
  worktreeId: string,
  tabId: string
): Tab | undefined {
  return state.unifiedTabsByWorktree?.[worktreeId]?.find(
    (tab) => tab.id === tabId && tab.contentType === 'agent-session'
  )
}

export function resolveWorkspaceReferenceObservationOwner(
  state: ObservationState,
  worktreeId: string,
  context: WorkspaceReferenceObservationContext
): NotificationWorkspaceOwner | null {
  if (context.kind === 'agent-session') {
    const tab = findAgentSessionTab(state, worktreeId, context.tabId)
    return tab ? resolveNotificationTabOwner(state, tab) : null
  }
  return resolveTerminalNotificationOwner(state, worktreeId, context)
}

export function getWorkspaceAttachmentObservedOrigin(
  state: ObservationState,
  worktreeId: string,
  context: WorkspaceReferenceObservationContext,
  hostId: ExecutionHostId | undefined
): WorkspaceAttachmentOrigin | undefined {
  if (context.kind !== 'agent-session') {
    return getWorkspaceAttachmentTerminalOrigin(state, worktreeId, context, hostId)
  }
  const tab = findAgentSessionTab(state, worktreeId, context.tabId)
  if (!tab) {
    return undefined
  }
  return {
    kind: 'observed',
    tabId: tab.id,
    ...(hostId ? { hostId } : {}),
    label: tab.customLabel || tab.label,
    ...(tab.agentSessionAgent ? { agent: tab.agentSessionAgent } : {}),
    sessionId: tab.entityId
  }
}

export function getWorkspaceAttachmentTerminalOrigin(
  state: Pick<AppState, 'tabsByWorktree' | 'agentStatusByPaneKey' | 'terminalLayoutsByTabId'>,
  worktreeId: string,
  context: WorkspaceReferenceTerminalContext,
  hostId: ExecutionHostId | undefined
): WorkspaceAttachmentOrigin | undefined {
  const tab = state.tabsByWorktree?.[worktreeId]?.find(
    (candidate) => candidate.id === context.tabId
  )
  const pane = parsePaneKey(context.paneKey)
  const layout = state.terminalLayoutsByTabId?.[context.tabId]
  if (!tab || !pane || pane.tabId !== tab.id || !layout) {
    return undefined
  }
  if (!terminalLayoutContainsLeaf(layout.root, pane.leafId)) {
    return undefined
  }
  const ptyId =
    layout.ptyIdsByLeafId?.[pane.leafId] ?? (layout.root?.type === 'leaf' ? tab.ptyId : null)
  if (!context.ptyId || context.ptyId !== ptyId) {
    return undefined
  }
  const entry = state.agentStatusByPaneKey?.[context.paneKey]
  const matchingEntry =
    (entry?.worktreeId && entry.worktreeId !== worktreeId) ||
    (entry?.terminalHandle && entry.terminalHandle !== ptyId)
      ? undefined
      : entry
  return {
    kind: 'observed',
    tabId: tab.id,
    paneKey: context.paneKey,
    ...(hostId ? { hostId } : {}),
    label: tab.customTitle || tab.defaultTitle || tab.title,
    ...(matchingEntry?.agentType ? { agent: matchingEntry.agentType } : {}),
    ...(matchingEntry?.providerSession?.id ? { sessionId: matchingEntry.providerSession.id } : {})
  }
}
