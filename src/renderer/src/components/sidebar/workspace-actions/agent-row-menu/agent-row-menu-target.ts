import type { AppState } from '@/store/types'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { structuredAgentSessionAddressTabId } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { collectLeafIds } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import { getPtyExecutionHost } from '../../../../../../shared/terminal/pty/lifecycle/terminal-execution-host'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { isExecutionHostForWorktree } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'
import { hasTerminalTabRenameListener } from '@/components/tab-bar/terminal-tabs/terminal-tab-rename-request'
import { resolveUnmirroredAgentTerminalOwner } from '@/lib/workspace/tabs/terminal-tab-owner-activation'
import { selectKnownWorktreeById } from '@/store/workspaces/selection/known-worktree-selection'
import { isWorktreeRetiredByRemoval } from '../../../../../../shared/worktree/removal/removal-visibility'

export type AgentRowMenuRowRef = {
  worktreeId: string
  /** The card's host; local and remote copies can share a workspace ID. */
  cardHostId: ExecutionHostId | undefined
  paneKey: string
  tabId: string
}

/** What an agent row resolves to; the incarnation fields make a same-pane replacement a different target. */
export type AgentRowMenuTarget = AgentRowMenuRowRef & {
  kind: 'terminal' | 'chat' | 'status'
  executionHostId: ExecutionHostId | null
  leafId: string | null
  unifiedTabId: string | null
  chatSessionId: string | null
  chatAgent: AgentType | null
  ptyId: string | null
  providerSessionId: string | null
  singleLeaf: boolean
}

function hostMatches(
  state: AppState,
  ref: AgentRowMenuRowRef,
  owner: ExecutionHostId | 'foreign' | null
): boolean {
  return (
    !ref.cardHostId ||
    !owner ||
    isExecutionHostForWorktree(state, ref.worktreeId, ref.cardHostId, owner)
  )
}

export function resolveAgentRowMenuTarget(
  state: AppState,
  ref: AgentRowMenuRowRef
): AgentRowMenuTarget | null {
  const status = state.agentStatusByPaneKey.get(ref.paneKey)
  const providerSessionId = status?.providerSession?.id ?? null
  const chat = getStructuredAgentSessionTabsByPaneKey(state.unifiedTabsByWorktree).get(ref.paneKey)
  if (
    chat?.worktreeId === ref.worktreeId &&
    (chat.id === ref.tabId ||
      structuredAgentSessionAddressTabId(chat.id, chat.entityId) === ref.tabId)
  ) {
    const owner = structuredAgentSessionOwnerForTab(state, chat)
    if (!structuredAgentSessionTargetForHost(owner) || !hostMatches(state, ref, owner)) {
      return null
    }
    return {
      ...ref,
      kind: 'chat',
      executionHostId: owner,
      leafId: null,
      unifiedTabId: chat.id,
      chatSessionId: chat.entityId,
      chatAgent: chat.agentSessionAgent ?? null,
      ptyId: null,
      providerSessionId,
      singleLeaf: true
    }
  }
  const parsed = parsePaneKey(ref.paneKey)
  if (!parsed || parsed.tabId !== ref.tabId) {
    return null
  }
  const layout = state.terminalLayoutsByTabId[ref.tabId]
  const ptyId = layout?.ptyIdsByLeafId?.[parsed.leafId] ?? null
  if (!hostMatches(state, ref, getPtyExecutionHost(ptyId ?? state.ptyIdsByTabId[ref.tabId]?.[0]))) {
    return null
  }
  const base = {
    ...ref,
    leafId: parsed.leafId,
    chatSessionId: null,
    chatAgent: null,
    ptyId,
    providerSessionId
  }
  if (state.tabsByWorktree[ref.worktreeId]?.some((tab) => tab.id === ref.tabId)) {
    const leaves = collectLeafIds(layout?.root)
    if (layout?.root && !leaves.includes(parsed.leafId)) {
      return null
    }
    const unified = state.unifiedTabsByWorktree[ref.worktreeId]?.find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === ref.tabId
    )
    return {
      ...base,
      kind: 'terminal',
      executionHostId: null,
      unifiedTabId: unified?.id ?? null,
      singleLeaf: leaves.length === 1 && leaves[0] === parsed.leafId
    }
  }
  const workspace = selectKnownWorktreeById(state, ref.worktreeId, ref.cardHostId)
  if (
    status?.worktreeId !== ref.worktreeId ||
    !workspace ||
    isWorktreeRetiredByRemoval(workspace)
  ) {
    return null
  }
  const environmentId = resolveUnmirroredAgentTerminalOwner(
    state,
    ref.worktreeId,
    status,
    ref.cardHostId
  )
  const hasProviderView =
    status.agentType === 'claude' &&
    !status.structuredHostOwned &&
    providerSessionId &&
    ptyId &&
    state.ptyIdsByTabId[ref.tabId]?.includes(ptyId)
  return environmentId || hasProviderView
    ? {
        ...base,
        kind: 'status',
        executionHostId: environmentId ? toRuntimeExecutionHostId(environmentId) : null,
        unifiedTabId: null,
        singleLeaf: false
      }
    : null
}

export function isSameAgentRowMenuTarget(
  captured: AgentRowMenuTarget,
  current: AgentRowMenuTarget | null
): current is AgentRowMenuTarget {
  return (
    current !== null &&
    current.kind === captured.kind &&
    current.executionHostId === captured.executionHostId &&
    current.tabId === captured.tabId &&
    current.leafId === captured.leafId &&
    current.unifiedTabId === captured.unifiedTabId &&
    current.chatSessionId === captured.chatSessionId &&
    current.chatAgent === captured.chatAgent &&
    current.ptyId === captured.ptyId &&
    current.providerSessionId === captured.providerSessionId
  )
}

/** Chats are their own incarnation; terminal rows need a PTY or provider session to act on a tab. */
export function hasAgentIncarnationEvidence(target: AgentRowMenuTarget): boolean {
  return target.kind === 'chat' || target.ptyId !== null || target.providerSessionId !== null
}

export type AgentRowMenuActions = {
  rename: boolean
  copyId: boolean
  fork: boolean
}

export function getAgentRowRenameListenerId(target: AgentRowMenuTarget): string | null {
  return target.kind === 'chat'
    ? target.unifiedTabId
    : target.kind === 'terminal'
      ? target.tabId
      : null
}

export function getAgentRowMenuActions(
  target: AgentRowMenuTarget,
  activeHere: boolean
): AgentRowMenuActions {
  const tabLevel =
    target.singleLeaf && target.kind !== 'status' && hasAgentIncarnationEvidence(target)
  const renameId = getAgentRowRenameListenerId(target)
  return {
    // Rename events are synchronous, so only a tab already mounted in the active workspace can take one.
    rename: tabLevel && activeHere && renameId !== null && hasTerminalTabRenameListener(renameId),
    copyId: tabLevel && target.unifiedTabId !== null,
    fork: target.kind === 'chat' && target.chatAgent !== null
  }
}
