/**
 * Turns a host-derived structured turn completion into unread markers and one OS notification.
 *
 * This is the structured lane's counterpart to `dispatchTerminalNotification`, and it deliberately
 * does NOT go through it. That function's first half arbitrates PTY evidence — a committed
 * terminal title against a hook status snapshot, with staleness and pane-reuse rules — because a
 * terminal only ever infers that a turn ended. A structured session does not infer: the execution
 * host derived this completion from its own journal commit and it carries an explicit outcome.
 * Running it through the terminal preamble would mean re-deriving a fact we were handed.
 *
 * What it does share is everything after that: the same neutral policy in
 * `attention/agent-attention-policy`, the same four store sinks, #21274's structured surface
 * adapter, and the same delivery tail — so suppression, acknowledgement, addressing, the success
 * sound and the blocked-permission fallback all have exactly one implementation.
 *
 * EVERY SETTLED TURN NOTIFIES, matching the CLI lane: success says "finished", and failure and
 * cancellation say "stopped" through the shipped `agentInterrupted` flag rather than a second
 * vocabulary. A turn with no outcome is UNKNOWN — the host sends no event for one, and nothing
 * here may turn that absence into success.
 *
 * Unread and delivery come out of ONE `resolveAgentAttention` decision. "Do not alert me about
 * something I am watching" is already answered by focus, in the surface adapter's viewed gates and
 * in main's `suppressWhenFocused`; there is no second suppression path here.
 */
import { AGENT_JOURNAL_TURN_OUTCOMES } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionTurnCompletion } from '../../../../shared/agent-session-wire'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { applyAgentAttention, resolveAgentAttention } from '@/attention/agent-attention-policy'
import {
  deliverAgentAttentionNotification,
  readAgentAttentionNotificationSound
} from '@/attention/agent-attention-notification-delivery'
import { useAppStore } from '@/store'
import { getNotificationWorkspaceLabels } from '../terminal-pane/terminal-notification-state'
import { createStructuredAttentionSurface } from './structured-attention-surface'
import type { StructuredTab } from './structured-agent-session-tabs'

export function dispatchStructuredTurnCompletionAttention(
  tab: StructuredTab,
  completion: AgentSessionTurnCompletion
): void {
  // ABSENT OUTCOME IS UNKNOWN AND LIGHTS NOTHING. The wire type makes it required and this host
  // never omits it, but a host that predates the field reaches here as `undefined`, and reading
  // that as anything — success or interrupted — invents a verdict nobody gave.
  if (!AGENT_JOURNAL_TURN_OUTCOMES.includes(completion.outcome)) {
    return
  }
  // The pane key below is built from the tab, so a completion for a session the tab has since been
  // rebound to something else would mark the NEW session's key with the OLD session's news. Checked
  // here rather than only at the subscription, because the key is minted here.
  if (completion.sessionId !== tab.entityId) {
    return
  }
  const state = useAppStore.getState()
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const decision = resolveAgentAttention(
    {
      // The tab's worktree, not `completion.scope.workspaceId`: the scope names the workspace on
      // the execution host, which for a remote host is not the id this store addresses tabs and
      // unread markers by. The tab is what the surface adapter resolves, so the tab decides.
      subject: { workspaceId: tab.worktreeId, surfaceKey: paneKey },
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
  if (!decision.admitted) {
    return
  }
  const row = state.agentStatusByPaneKey[paneKey]
  // Minted from the row as it stands; the row's start can move afterwards (this can outrun the
  // settled re-projection), so acknowledgement retires by subject: main keeps the ids it announced
  // per pane. Null only when no row has landed at all; delivery still goes out then,
  // undismissible, rather than being held back for bookkeeping.
  const notificationId = buildAgentNotificationId({
    worktreeId: tab.worktreeId,
    paneKey,
    stateStartedAt: row?.stateStartedAt
  })
  const sound = readAgentAttentionNotificationSound(state.settings ?? {})
  applyAgentAttention(decision, {
    unread: {
      markWorkspaceUnread: state.markWorktreeUnread,
      markSubjectUnread: state.markAgentCompletionPaneUnread,
      markGroupUnread: state.markTerminalTabUnread,
      markSurfaceUnread: state.markTerminalPaneUnread
    },
    requestDelivery: (request) => {
      deliverAgentAttentionNotification(
        {
          source: 'agent-task-complete',
          surface: 'agent-session',
          ...(notificationId ? { notificationId } : {}),
          worktreeId: request.workspaceId,
          paneKey: request.subjectKey ?? undefined,
          ...getNotificationWorkspaceLabels(state, request.workspaceId, tab.label),
          terminalTitle: tab.label,
          isActiveWorktree: request.workspaceIsActive,
          ...(row?.agentType ? { agentType: row.agentType } : {}),
          // 'done' is what the host told us, not an inference from the row — the row's own state
          // can still read 'working' when the completion outruns the status re-projection, and
          // main words a 'working' notification as "working". The outcome picks the wording from
          // there: interrupted covers failure and cancellation alike.
          agentState: 'done',
          agentInterrupted: completion.outcome !== 'success',
          ...(row?.prompt ? { agentPrompt: row.prompt } : {}),
          ...(row?.lastAssistantMessage
            ? { agentLastAssistantMessage: row.lastAssistantMessage }
            : {})
        },
        sound
      )
    }
  })
}
