/**
 * Turns a host-derived structured turn completion into unread markers.
 *
 * This is the structured lane's counterpart to `dispatchTerminalNotification`, and it deliberately
 * does NOT go through it. That function's first half arbitrates PTY evidence — a committed
 * terminal title against a hook status snapshot, with staleness and pane-reuse rules — because a
 * terminal only ever infers that a turn ended. A structured session does not infer: the execution
 * host derived this completion from its own journal commit and it carries an explicit outcome.
 * Running it through the terminal preamble would mean re-deriving a fact we were handed.
 *
 * What it does share is the part that matters: the same neutral policy in
 * `attention/agent-attention-policy`, the same four store sinks, and #21274's structured surface
 * adapter — so suppression, acknowledgement and addressing have exactly one implementation.
 *
 * NO OS DELIVERY HERE. `applyAgentAttentionUnread` is called rather than `applyAgentAttention`,
 * so this writes markers and requests no notification. Desktop/mobile delivery is a separate
 * concern with its own dedupe, and wiring a half-built one here would double-notify mobile.
 */
import type { AgentSessionTurnCompletion } from '../../../../shared/agent-session-wire'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  applyAgentAttentionUnread,
  resolveAgentAttention
} from '@/attention/agent-attention-policy'
import { useAppStore } from '@/store'
import { createStructuredAttentionSurface } from './structured-attention-surface'
import type { StructuredTab } from './structured-agent-session-tabs'

export function dispatchStructuredTurnCompletionAttention(
  tab: StructuredTab,
  completion: AgentSessionTurnCompletion
): void {
  // ONLY SUCCESS LIGHTS ANYTHING. A failure or a cancellation is not something the user is being
  // called back to read, and a turn with no outcome at all is UNKNOWN — the host does not send one,
  // and nothing here may turn its absence into success.
  if (completion.outcome !== 'success') {
    return
  }
  // The pane key below is built from the tab, so a completion for a session the tab has since been
  // rebound to something else would mark the NEW session's key with the OLD session's news. Checked
  // here rather than only at the subscription, because the key is minted here.
  if (completion.sessionId !== tab.entityId) {
    return
  }
  const state = useAppStore.getState()
  const decision = resolveAgentAttention(
    {
      // The tab's worktree, not `completion.scope.workspaceId`: the scope names the workspace on
      // the execution host, which for a remote host is not the id this store addresses tabs and
      // unread markers by. The tab is what the surface adapter resolves, so the tab decides.
      subject: {
        workspaceId: tab.worktreeId,
        surfaceKey: structuredAgentSessionPaneKey(tab.id, tab.entityId)
      },
      reason: 'agent-completion',
      settlesTurn: true,
      // The host watched the turn settle in its own journal. That is the out-of-band proof this
      // flag is for, and it is why a backgrounded chat with no rendered transcript still counts —
      // admission below still rejects a key the tab no longer owns.
      hasFreshActivityEvidence: true,
      // Parity with the terminal lane: the tab dot is the same experimental presentation policy
      // for both, so it reads the same setting rather than a second one.
      groupAttentionEnabled: state.settings?.experimentalTerminalAttention === true
    },
    createStructuredAttentionSurface(state)
  )
  if (!decision.admitted || decision.unread === null) {
    return
  }
  applyAgentAttentionUnread(decision.unread, {
    markWorkspaceUnread: state.markWorktreeUnread,
    markSubjectUnread: state.markAgentCompletionPaneUnread,
    markGroupUnread: state.markTerminalTabUnread,
    markSurfaceUnread: state.markTerminalPaneUnread
  })
}
