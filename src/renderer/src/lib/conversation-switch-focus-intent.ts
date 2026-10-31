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

/**
 * A paired client's switch of a terminal pane to chat: the chat lands where this client looks only
 * if the source still holds its selection when the chat arrives. Recorded before the request, so
 * a snapshot ahead of the answer, or a lost answer, still finds it; matched by the slot the host
 * names, so a chat the host reused still lands. On this host's own window, main focuses instead.
 * Returns how to withdraw it after a definite refusal.
 */
export function recordConversationSwitchFocus(args: {
  target: RuntimeClientTarget
  workspaceId: string
  /** This client's id for the source tab, and the host's. */
  sourceTabId: string
  hostSourceTabId: string | undefined
  chatSessionId: string
}): () => void {
  const state = useAppStore.getState()
  if (
    args.target.kind === 'local' ||
    !args.hostSourceTabId ||
    resolveWebSessionVisibleTabId(state, args.workspaceId) !== args.sourceTabId
  ) {
    return () => {}
  }
  const owner = structuredAgentSessionFocusOwner(args.target)
  const hostTabId = `agent-session:${args.chatSessionId}`
  recordWebSessionFocusIntent(
    owner,
    args.workspaceId,
    hostTabId,
    undefined,
    args.sourceTabId,
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
  const hostTabId = `agent-session:${intent.sessionId}`
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
