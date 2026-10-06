// The capabilities that gate how a structured send is answered, and how a message that failed
// before any agent took it is sent again.

// Why: older structured clients render durable pending replies as uncertain delivery. Capable
// clients skip the host's bounded best-effort settlement observation.
export const AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY =
  'agent-session.pending-send-result.v1' as const
// Why: a send is now answered once the host accepts it, before any agent has it. A client without
// this cannot show a message rejected after that answer, so the host holds its reply until the
// message is handed over or rejected. Transitional: drop the hold once no supported desktop or
// mobile client lacks the capability; mobile must first show a rejected message in place.
export const AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY =
  'agent-session.accepted-send.v1' as const
// Why: a host advertising this answers a resent send id from its record before anything else may
// refuse it, so a refusal `agentSession.send` RETURNS is proof; a thrown error never is, a thrown
// refusal included (host not installed, journal database won't open, host disabled). Reading a
// returned `ok: false`: `agent_session_operation_unknown` with `outcomeUnknown` or `resultLost` —
// the host cannot tell yet, resend the same id; with `rewindUnconfirmed` — settled, nothing was
// written. `agent_session_operation_expired` — only the transcript can tell. An
// `agent_session_operation_conflict` or `messageIdReused` — the id holds a different payload,
// which proves nothing about this message; nor does `sessionNotAttached` (the chat's record is
// gone or unreadable on this host). Any other — the chat holds no message under that id and none
// is in flight, but a resend of that id may still run as a new send, so a client that hands the
// text back must not resend the old id. An older host may refuse an id it recorded: none of this
// holds there.
export const AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY =
  'agent-session.send-answers-proof.v1' as const
// Why: `agentSession.retryMessage` queues a message no agent took again under its own id; an older
// host has no such method, so a client must learn it during negotiation and otherwise keep Retry
// as a new message.
export const AGENT_SESSION_RETRY_MESSAGE_RUNTIME_CAPABILITY =
  'agent-session.retry-message.v1' as const

// How a send is answered. The host and the Electron client both advertise these.
export const AGENT_SESSION_SEND_ANSWER_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY
] as const

// The host side: it accepts a send before any agent has it, and a Stop with no writer before a
// turn starts, so a client may gate on either.
export const AGENT_SESSION_MESSAGE_DELIVERY_RUNTIME_CAPABILITIES = [
  ...AGENT_SESSION_SEND_ANSWER_RUNTIME_CAPABILITIES,
  AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY,
  AGENT_SESSION_RETRY_MESSAGE_RUNTIME_CAPABILITY
] as const
