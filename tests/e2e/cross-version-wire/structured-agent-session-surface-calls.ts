import { expect } from 'vitest'

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
export const STATUS_FEED_METHOD = 'agentSession.subscribeStatus'
export const TURN_COMPLETION_FEED_METHOD = 'agentSession.subscribeTurnCompletions'

/** Every method the structured surface publishes: the host method it must reach,
 *  and the result it must hand back. A gate that hides one method and leaks
 *  another is the bug; so is a method that is registered and answers with an
 *  error, which is why `result` is declared per method rather than inferred from
 *  "did not say method_not_found". `result` is omitted only where the method
 *  legitimately answers with no reply at all. */
export const STRUCTURED_CALLS: {
  method: string
  hostMethod: string | null
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
  // Draft mutations for mid-turn queueing. Methods exist ahead of the
  // capability's advertisement; only capability-gated clients ever call them.
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
  // A chat's visual, read from the host's own record and state directory. A bare addition: an older
  // host answers `method_not_found` and the client shows the visual as unavailable. The stub host
  // holds no record, so the typed refusal is the declared answer.
  {
    method: 'agentSession.readVisual',
    hostMethod: null,
    result: { ok: false, error: 'session_not_found' }
  },
  // A no-op on a host that starts an agent only for work; it still builds the host.
  { method: 'agentSession.hold', hostMethod: null, result: { held: true } },
  // The restart-resume surface. Bare additions, not capability-negotiated: an RPC method's
  // absence is explicit (`method_not_found`), which the old-dispatcher case below asserts, so a
  // newer client learns it during negotiation instead of by being met with silence.
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
  { method: 'agentSession.release', hostMethod: null, result: { released: true } },
  {
    method: 'agentSession.history',
    hostMethod: 'history',
    result: { ok: true, page: { items: [] } }
  },
  {
    method: CONVERSATION_OUTLINE_METHOD,
    hostMethod: 'journalSnapshot',
    result: { sessionId: SESSION, entries: [], omittedEntries: 0 }
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
  // Opens with nothing for the same reason `agentSession.subscribe` does, and unlike the status
  // feed above: a completion is an edge that has already passed, not state a late subscriber
  // needs. Reaching the host is the only signal that the gate opened.
  {
    method: TURN_COMPLETION_FEED_METHOD,
    hostMethod: 'subscribeTurnCompletions'
  },
  // Reading a chat retires the phone alerts its host pushed, through the runtime's own store, so
  // its reply is the only signal that the gate opened.
  {
    method: 'agentSession.acknowledgeAttention',
    hostMethod: null,
    result: { acknowledged: true }
  },
  // Teardown runs through the runtime's subscription registry rather than the
  // host, so its reply is the only signal that the gate opened.
  { method: 'agentSession.unsubscribe', hostMethod: null, result: { unsubscribed: true } },
  // The host's registered agents, each with its declared capability record. Builds before
  // #25845 read them from the installed host; later ones from the registrations that host is
  // built from, so they answer without installing it. Either way Codex is listed.
  {
    method: 'agentSession.agents',
    hostMethod: null,
    result: { agents: expect.arrayContaining([expect.objectContaining({ agent: 'codex' })]) }
  }
]
