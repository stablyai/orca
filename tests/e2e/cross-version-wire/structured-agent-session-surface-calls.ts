import { expect } from 'vitest'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../../src/shared/agent-session-current-requests-capability'

export const SESSION = 'session-alpha'
export const WORKSPACE = 'workspace-1'
export const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
export const NOW = 1_800_000_000_000
export const ATTENTION_READ = {
  sessionId: SESSION,
  observedCursor: { epoch: 'attention-epoch', sequence: 7 }
} as const
export const REWIND_METHOD = 'agentSession.rewind'
export const CONVERSATION_OUTLINE_METHOD = 'agentSession.conversationOutline'
export const ITEM_DETAIL_METHOD = 'agentSession.item'
export const STATUS_FEED_METHOD = 'agentSession.subscribeStatus'
export const TURN_COMPLETION_FEED_METHOD = 'agentSession.subscribeTurnCompletions'

// Declare each method’s expected host call and result; registration or a non-method_not_found error cannot prove execution.
// Omit result only for streams that legitimately open without a reply.
export const STRUCTURED_CALLS: {
  method: string
  hostMethod: string | null
  clientCapability?: string
  result?: Record<string, unknown>
}[] = [
  { method: 'agentSession.createSupport', hostMethod: null, result: { supported: true } },
  {
    method: 'agentSession.create',
    hostMethod: 'attach',
    result: { ok: true, replayed: false, value: { sessionId: SESSION } }
  },
  {
    method: 'agentSession.ensure',
    hostMethod: 'attach',
    result: { ok: true, replayed: false, value: { sessionId: SESSION } }
  },
  {
    method: 'agentSession.conversationCommand',
    hostMethod: 'conversationCommand',
    result: { ok: true, value: { command: 'compact', state: 'completed' } }
  },
  { method: 'agentSession.send', hostMethod: 'send', result: { ok: true, replayed: false } },
  { method: 'agentSession.cancel', hostMethod: 'cancel', result: { ok: true, replayed: false } },
  // Only capability-gated clients call these methods, even before advertisement.
  {
    method: 'agentSession.queuedMessageSend',
    hostMethod: 'queuedMessageSend',
    result: { ok: true, replayed: false }
  },
  {
    method: 'agentSession.queuedMessageDelete',
    hostMethod: 'queuedMessageDelete',
    result: { ok: true, replayed: false }
  },
  {
    method: 'agentSession.queuedMessageMove',
    hostMethod: 'queuedMessageMove',
    result: { ok: true, value: { messageId: 'queued-1', status: 'moved' } }
  },
  {
    method: 'agentSession.queuedMessagesResume',
    hostMethod: 'queuedMessagesResume',
    result: { ok: true, replayed: false }
  },
  // Editing a queued card in place. Clients call these only on a host advertising
  // `agent-session.queued-message-edit.v1`; an older host answers `method_not_found`.
  {
    method: 'agentSession.queuedMessageUpdate',
    hostMethod: 'queuedMessageUpdate',
    result: { ok: true, replayed: false }
  },
  {
    method: 'agentSession.queuedMessageEditHold',
    hostMethod: 'queuedMessageEditHold',
    result: { status: 'held' }
  },
  {
    method: REWIND_METHOD,
    hostMethod: 'rewind',
    result: { ok: true, replayed: false, value: { itemId: 'item-1', epoch: 'rewound-epoch' } }
  },
  { method: 'agentSession.close', hostMethod: 'close', result: { ok: true } },
  {
    method: 'agentSession.sleepWorkspace',
    hostMethod: 'sleepWorkspace',
    result: { stoppedSessionIds: [] }
  },
  {
    method: 'agentSession.respondToApproval',
    hostMethod: 'respondToPrompt',
    result: { ok: true, replayed: false }
  },
  {
    method: 'agentSession.respondToQuestion',
    hostMethod: 'respondToPrompt',
    result: { ok: true, replayed: false }
  },
  {
    method: 'agentSession.setOption',
    hostMethod: 'setOption',
    result: { ok: true, replayed: false }
  },
  {
    method: 'agentSession.threadGoal',
    hostMethod: 'changeThreadGoal',
    result: { ok: true, replayed: false }
  },
  {
    method: 'agentSession.handoffStatus',
    hostMethod: 'handoffStatus',
    result: { owner: 'native' }
  },
  {
    method: 'agentSession.options',
    hostMethod: 'readOptions',
    result: { current: { model: 'gpt-live' } }
  },
  {
    method: 'agentSession.modelCatalog',
    hostMethod: 'modelCatalog',
    result: { origin: 'unknown' }
  },
  {
    method: 'agentSession.commands',
    hostMethod: 'readCommands',
    result: { commands: [{ name: 'clear', kind: 'command' }] }
  },
  {
    method: 'agentSession.reveal',
    hostMethod: 'revealSession',
    result: { ok: true, sessionId: SESSION, workspaceId: WORKSPACE, agent: 'codex', readable: true }
  },
  // The stub has no record, so readVisual must return its typed refusal; older hosts return method_not_found.
  {
    method: 'agentSession.readVisual',
    hostMethod: null,
    result: { ok: false, error: 'session_not_found' }
  },
  // A no-op on a host that starts an agent only for work; it still builds the host.
  { method: 'agentSession.hold', hostMethod: null, result: { held: true } },
  // Restart-resume methods negotiate absence through explicit method_not_found, never silence.
  {
    method: 'agentSession.restartResumable',
    hostMethod: 'restartResumableList',
    result: { sessions: [] }
  },
  {
    method: 'agentSession.restartResumableDismiss',
    hostMethod: 'restartResumableDismiss',
    result: { dismissed: 0 }
  },
  // Reattaching alone is nothing now, so this answers that nothing was resumed.
  { method: 'agentSession.restartResume', hostMethod: null, result: { results: [] } },
  {
    method: 'agentSession.restartContinue',
    hostMethod: 'restartContinueAll',
    result: { resumed: [], continued: [] }
  },
  // Continue on a reply an Orca stop cut off. Clients call it only on a host advertising it.
  {
    method: 'agentSession.continueInterrupted',
    hostMethod: 'continueInterrupted',
    result: { sessionId: SESSION, outcome: 'superseded' }
  },
  // Name a chat again after naming failed. Clients call it only on a host advertising
  // `agent-session.structured.regenerate-name.v1`; an older host answers `method_not_found`.
  {
    method: 'agentSession.regenerateName',
    hostMethod: 'regenerateConversationName',
    result: { accepted: true }
  },
  // Save the user's chat name. Clients call it only on a host advertising
  // `agent-session.structured.rename.v1`; an older host answers `method_not_found`.
  {
    method: 'agentSession.rename',
    hostMethod: 'setUserConversationName',
    result: { name: 'Release notes', applied: true }
  },
  { method: 'agentSession.release', hostMethod: null, result: { released: true } },
  {
    method: 'agentSession.history',
    hostMethod: 'history',
    result: { ok: true, page: { items: [] } }
  },
  {
    method: 'agentSession.currentRequests',
    hostMethod: 'readCurrentRequests',
    clientCapability: AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
    result: { json: '[]', nextCursor: null }
  },
  {
    method: CONVERSATION_OUTLINE_METHOD,
    hostMethod: 'journalSnapshot',
    result: { sessionId: SESSION, entries: [], omittedEntries: 0 }
  },
  {
    method: ITEM_DETAIL_METHOD,
    hostMethod: 'journalSnapshot',
    result: { item: null }
  },
  // A subscription that opens with nothing to say answers with no reply at all,
  // so reaching the host is the only signal that the gate opened.
  { method: 'agentSession.subscribe', hostMethod: 'subscribe' },
  // The status feed opens with a snapshot of every session, so its first reply is the contract.
  {
    method: STATUS_FEED_METHOD,
    hostMethod: 'subscribeStatus',
    result: { type: 'snapshot', sessions: [] }
  },
  // Completion is an edge, so an empty opening stream is valid; the host-call delta proves admission.
  {
    method: TURN_COMPLETION_FEED_METHOD,
    hostMethod: 'subscribeTurnCompletions'
  },
  // Attention acknowledgement uses the runtime store; only its reply proves admission.
  {
    method: 'agentSession.acknowledgeAttention',
    hostMethod: null,
    result: { acknowledged: true }
  },
  // Teardown runs through the runtime's subscription registry rather than the
  // host, so its reply is the only signal that the gate opened.
  { method: 'agentSession.unsubscribe', hostMethod: null, result: { unsubscribed: true } },
  // Before #25845 agents came from the installed host; later builds read registrations directly. Both must list Codex.
  {
    method: 'agentSession.agents',
    hostMethod: null,
    result: { agents: expect.arrayContaining([expect.objectContaining({ agent: 'codex' })]) }
  },
  // Availability uses a runtime resource; its first generation proves admission.
  {
    method: 'agentSession.subscribeAvailability',
    hostMethod: null,
    result: { type: 'availability', agents: [] }
  }
]
