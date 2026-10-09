import type { TuiAgent } from '../../../shared/tui-agent'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatLaunchPermissionMode,
  agentChatPermissionModes
} from '../../../shared/agent-chat-permission-mode'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import type { Tab } from '../../../shared/tab-types'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { useAppStore } from '@/store'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { getStructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch-registry'
import { isStructuredLaunchChatEmpty } from './structured-agent-session-launch-empty-chat'

export type IdleEmptyStructuredChat = { sessionId: string; executionHostId: ExecutionHostId }

/** Whether an empty chat can stand in for a new one starting in `startingMode`: it started there
 *  and has since only narrowed to Ask, where a provider's narrowing lands, never widened. A
 *  record that predates its starting mode compares its saved mode instead. */
function startsAsNewChat(summary: AgentSessionStatusSummary, startingMode: string): boolean {
  const initial = summary.initialPermissionMode
  const current = summary.permissionMode
  if (initial === undefined) {
    return current === startingMode
  }
  return (
    initial === startingMode && current !== undefined && (current === initial || current === 'ask')
  )
}

/** Published, and its host's journal holds no request (a null status). A resumed chat's journal
 *  holds the imported conversation, so it never reads as empty. A host that names the mode a new
 *  chat starts in only offers an empty chat that started there, so a changed default opens one. */
function hostOffersEmptyChat(
  tab: Tab,
  executionHostId: ExecutionHostId,
  permissionMode: string | undefined
): boolean {
  const lifecycle = getStructuredAgentSessionLaunchLifecycle(tab.worktreeId, tab.entityId)
  const target = structuredAgentSessionTargetForHost(executionHostId)
  if ((lifecycle !== null && lifecycle !== 'published') || !target) {
    return false
  }
  const feed = getStructuredAgentSessionStatusFeed(target)
  const summary = feed.getSnapshot().get(tab.entityId)
  // Why live only: a summary cached across a lost stream may predate a message the host took.
  return (
    feed.getSessionObservation(tab.entityId) === 'live' &&
    summary?.status === null &&
    (permissionMode === undefined || startsAsNewChat(summary, permissionMode))
  )
}

/** The mode a new chat would start in: what its host reported, else, for this machine's own chats
 *  (a slow or unresolved admission reports nothing), this machine's setting. */
export function newChatPermissionMode(
  agent: TuiAgent,
  executionHostId: ExecutionHostId | undefined,
  hostSeedOptions: Readonly<Record<string, string>> | undefined
): string | undefined {
  const reported = hostSeedOptions?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  const settings = useAppStore.getState().settings
  // Settings hold the active runtime's default; only a local active runtime makes them this host's.
  if (
    reported !== undefined ||
    executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    !settings ||
    getActiveRuntimeTarget(settings).kind !== 'local' ||
    !agentChatPermissionModes(agent)
  ) {
    return reported
  }
  return agentChatLaunchPermissionMode(agent, null, settings.nativeChatPermissionMode)
}

/** A launch draft its composer has not taken in yet (a chat opened in the background). */
function holdsUnadoptedLaunchDraft(tabId: string): boolean {
  const draft = useAppStore.getState().nativeChatLaunchDraftByTabId[tabId]
  return Boolean(draft && !draft.adopted && !draft.resolved && draft.text.trim())
}

/** An open chat for `agent` in this workspace's `groupId` (else any group) that nothing was ever
 *  sent into and whose composer is untouched. Prefers the group's active tab, else the newest.
 *  `permissionMode`: the mode the host said a new chat would start in, when it said one. */
export function findIdleEmptyStructuredChat(
  worktreeId: string,
  agent: TuiAgent,
  executionHostId?: ExecutionHostId,
  groupId?: string,
  permissionMode?: string
): IdleEmptyStructuredChat | undefined {
  const state = useAppStore.getState()
  const candidates: (IdleEmptyStructuredChat & { tab: Tab })[] = []
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    const owner =
      tab.contentType === 'agent-session' && tab.agentSessionAgent === agent
        ? structuredAgentSessionOwnerForTab(state, tab)
        : null
    if (
      owner &&
      (!groupId || tab.groupId === groupId) &&
      (!executionHostId || owner === executionHostId) &&
      hostOffersEmptyChat(tab, owner, permissionMode) &&
      isStructuredLaunchChatEmpty(tab.entityId) &&
      !holdsUnadoptedLaunchDraft(tab.id)
    ) {
      candidates.push({ sessionId: tab.entityId, executionHostId: owner, tab })
    }
  }
  if (candidates.length === 0) {
    return undefined
  }
  const focusGroupId = groupId ?? state.activeGroupIdByWorktree[worktreeId]
  const focusedTabId = state.groupsByWorktree[worktreeId]?.find(
    (group) => group.id === focusGroupId
  )?.activeTabId
  const chosen =
    candidates.find((candidate) => candidate.tab.id === focusedTabId) ??
    candidates.toSorted((a, b) => a.tab.createdAt - b.tab.createdAt).at(-1)
  return chosen && { sessionId: chosen.sessionId, executionHostId: chosen.executionHostId }
}
