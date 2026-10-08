/**
 * Turns a host-derived structured edge — a settled turn, or a prompt put to the user mid-turn — into
 * unread markers and one OS notification.
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
 * EVERY SETTLED TURN NOTIFIES, matching the CLI lane: the outcome picks the wording — "finished",
 * "failed" or "stopped" — exactly as the hook lane's verdict does. A turn with no outcome is UNKNOWN — the host sends no event for one, and nothing
 * here may turn that absence into success. A clean settle while a prompt (a subagent's approval,
 * say) waits on the user is worded "needs input" instead, as the hook lane words a blocked row; a
 * failure keeps its own wording. So is every prompt the host raises, once per prompt, as the hook
 * lane alerts on a blocked or waiting row. The wording rule is `agentSessionAttentionNews`, shared
 * with the host's own phone push.
 *
 * Prompt news already covered by an actual read is quiet, even when its attention frame arrives
 * later. Unread and delivery otherwise share the existing `resolveAgentAttention` decision.
 */
import { notificationSourceForOwner } from '../../../../shared/notification-source'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { resolveNotificationTabOwner } from '@/attention/notification-subject-owner'
import type {
  AgentSessionPromptAttention,
  AgentSessionTurnCompletion
} from '../../../../shared/agent-session-wire'
import {
  agentSessionAttentionKey,
  agentSessionAttentionNews,
  attentionOriginWasRead,
  structuredAttentionOrigin,
  type AgentSessionAttentionEdge,
  type StructuredAttentionRead
} from '../../../../shared/agent-session-attention'
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
  completion: AgentSessionTurnCompletion,
  subscriptionTarget?: RuntimeClientTarget
): void {
  dispatchStructuredAttention(tab, { type: 'completion', completion }, subscriptionTarget)
}

export function dispatchStructuredPromptAttention(
  tab: StructuredTab,
  prompt: AgentSessionPromptAttention,
  subscriptionTarget?: RuntimeClientTarget,
  readFrontier?: () => StructuredAttentionRead | undefined
): void {
  dispatchStructuredAttention(tab, { type: 'prompt', prompt }, subscriptionTarget, readFrontier)
}

function dispatchStructuredAttention(
  tab: StructuredTab,
  edge: AgentSessionAttentionEdge,
  subscriptionTarget: RuntimeClientTarget | undefined,
  readFrontier?: () => StructuredAttentionRead | undefined
): void {
  // 'done' and 'blocked' are what the host told us, not the row's state: the row can still read
  // 'working' when the edge outruns the status re-projection. ABSENT OUTCOME IS UNKNOWN AND LIGHTS
  // NOTHING: a host that predates the field reaches here with `undefined`.
  const news = agentSessionAttentionNews(edge)
  if (!news) {
    return
  }
  const sessionId = edge.type === 'prompt' ? edge.prompt.sessionId : edge.completion.sessionId
  // The pane key below is built from the tab, so news for a session the tab has since been
  // rebound to something else would mark the NEW session's key with the OLD session's news. Checked
  // here rather than only at the subscription, because the key is minted here.
  if (sessionId !== tab.entityId) {
    return
  }
  const origin = structuredAttentionOrigin(edge)
  const promptWasRead = (): boolean => {
    const read = readFrontier?.()
    return edge.type === 'prompt' && read !== undefined && attentionOriginWasRead(origin, read)
  }
  if (promptWasRead()) {
    return
  }
  const attentionKey = agentSessionAttentionKey(edge)
  const state = useAppStore.getState()
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const decision = resolveAgentAttention(
    {
      // The tab's worktree, not `completion.scope.workspaceId`: the scope names the workspace on
      // the execution host, which for a remote host is not the id this store addresses tabs and
      // unread markers by. The tab is what the surface adapter resolves, so the tab decides.
      subject: { workspaceId: tab.worktreeId, surfaceKey: paneKey },
      reason: 'agent-completion',
      // A prompt earns unread like a settled turn, as the hook lane's blocked row does.
      settlesTurn: true,
      // The host saw this edge in its own journal. That is the out-of-band proof this
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
  const sound = readAgentAttentionNotificationSound(state.settings ?? {})
  applyAgentAttention(decision, {
    unread: {
      markWorkspaceUnread: state.markWorktreeUnread,
      markSubjectUnread: state.markAgentCompletionPaneUnread,
      markGroupUnread: state.markTerminalTabUnread,
      markSurfaceUnread: state.markTerminalPaneUnread
    },
    requestDelivery: (request) => {
      // Unread writes can synchronously cause a genuine read before delivery.
      if (promptWasRead()) {
        return
      }
      deliverAgentAttentionNotification(
        {
          source: 'agent-task-complete',
          surface: 'agent-session',
          // Acknowledgement retires by subject (main keeps the ids it announced per pane), and the
          // shared id lets it retire the phone notification the host pushed under the same id.
          notificationId: attentionKey,
          attentionKey,
          structuredOrigin: origin,
          // A local session's host is this app's own main, which already pushed its phones.
          ...(subscriptionTarget?.kind === 'local' ? { mobileDeliveredByHost: true } : {}),
          worktreeId: request.workspaceId,
          paneKey: request.subjectKey ?? undefined,
          ...getNotificationWorkspaceLabels(state, request.workspaceId, tab.label),
          notificationSourceId: notificationSourceForOwner(
            // The receiving subscription identifies the paired source even when tab ownership is ambiguous.
            subscriptionTarget?.kind === 'environment'
              ? { executionHostId: null, runtimeEnvironmentId: subscriptionTarget.environmentId }
              : resolveNotificationTabOwner(state, tab),
            state
          ),
          terminalTitle: tab.label,
          isActiveWorktree: request.workspaceIsActive,
          ...(row?.agentType ? { agentType: row.agentType } : {}),
          agentState: news.agentState,
          ...(news.outcome ? { agentTurnOutcome: news.outcome } : {}),
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
