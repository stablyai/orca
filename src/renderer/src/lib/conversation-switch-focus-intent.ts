import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toHostSessionTabId
} from '../../../shared/terminal-surface-id'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-focus-intent'
import { agentSessionRowId } from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import { publishedChatRowId } from '@/runtime/structured-agent-session-tab-retirement'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'

/** The row the chat will be listed under: the one it publishes from a tab here that already holds
 *  it (the host reuses that tab), else its session row. */
function chatRowOf(target: RuntimeClientTarget, worktreeId: string, sessionId: string): string {
  const state = useAppStore.getState()
  const holder = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
  )
  return holder
    ? publishedChatRowId(state, target, worktreeId, holder)
    : agentSessionRowId(sessionId)
}

/**
 * A paired client's switch of a split pane to chat: the chat opens beside the source's tab, and
 * lands where this client looks only if that tab still holds its selection when the chat arrives
 * (a whole tab needs nothing: the same tab holds the chat). From Session History the user asked
 * from wherever they look, so the chat is selected as any chat they open is (if that tab still
 * holds the selection). Recorded before the request, so a snapshot ahead of the answer, or a lost
 * answer, still finds it; matched by the slot the host names, so a chat the host reused still
 * lands. On this host's own window, main focuses instead. Returns how to withdraw it after a
 * definite refusal.
 */
export function recordConversationSwitchFocus(args: {
  target: RuntimeClientTarget
  workspaceId: string
  /** This client's id for the source terminal, and the host's for its tab. */
  sourceTabId: string
  hostSourceTabId: string | undefined
  chatSessionId: string
  fromHistory?: boolean
}): () => void {
  const state = useAppStore.getState()
  const visible = resolveWebSessionVisibleTabId(state, args.workspaceId)
  const shown = state.unifiedTabsByWorktree[args.workspaceId]?.find((tab) => tab.id === visible)
  const split =
    collectLayoutLeafIdsInOrder(state.terminalLayoutsByTabId[args.sourceTabId]?.root ?? null)
      .length > 1
  if (
    args.target.kind === 'local' ||
    !args.hostSourceTabId ||
    (!args.fromHistory && (!split || shown?.entityId !== args.sourceTabId))
  ) {
    return () => {}
  }
  const owner = structuredAgentSessionFocusOwner(args.target)
  const hostTabId = chatRowOf(args.target, args.workspaceId, args.chatSessionId)
  recordWebSessionFocusIntent(
    owner,
    args.workspaceId,
    hostTabId,
    undefined,
    visible,
    args.hostSourceTabId
  )
  return () => clearWebSessionFocusIntentIfMatches(owner, args.workspaceId, hostTabId)
}

/**
 * The request for a chat opened with no source to stop (History, or a pane whose binding is gone):
 * selected where this client looks, as any chat the user opens is, and right after the source's
 * tab when one is known (a chat the host reused lands by that slot). Returns how to withdraw the
 * focus after a definite refusal.
 */
export function uncapturedSwitchChat(
  /** A new chat's launch intent, or an existing chat (no params) the host reopens. */
  intent: Pick<StructuredAgentSessionLaunchIntent, 'target' | 'worktreeId' | 'sessionId'> &
    Partial<Pick<StructuredAgentSessionLaunchIntent, 'params'>>,
  invocationId: string,
  /** This client's id for the source's tab. */
  sourceTab: string | undefined
) {
  const { worktreeId } = intent
  const owner = structuredAgentSessionFocusOwner(intent.target)
  const hostTabId = chatRowOf(intent.target, worktreeId, intent.sessionId)
  const sourceTabId = sourceTab
    ? toHostSessionTabId(sourceTab).split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]
    : undefined
  recordWebSessionFocusIntent(
    owner,
    worktreeId,
    hostTabId,
    undefined,
    resolveWebSessionVisibleTabId(useAppStore.getState(), worktreeId),
    sourceTabId
  )
  return {
    sessionId: intent.sessionId,
    abandonFocus: () => clearWebSessionFocusIntentIfMatches(owner, worktreeId, hostTabId),
    execution: {
      invocationId,
      ...(intent.params ? { create: intent.params } : {}),
      ...(sourceTabId ? { sourceTabId } : {})
    }
  }
}
