import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
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
