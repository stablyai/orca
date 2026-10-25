import { AGENT_SESSION_ATTENTION_RUNTIME_CAPABILITIES } from './agent-session-attention-capabilities'
import { AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY } from './agent-session-background-task-child-views-capability'
import { AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } from './agent-session-continue-interrupted-capability'
import { AGENT_SESSION_CREATE_RUNTIME_CAPABILITIES } from './agent-session-create-capabilities'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from './agent-session-current-requests-capability'
import { AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY } from './agent-session-permission-modes-capability'
import { AGENT_SESSION_RESUME_RUNTIME_CAPABILITIES } from './agent-session-resume-runtime-capabilities'
import { AGENT_SESSION_STOP_RUNTIME_CAPABILITIES } from './agent-session-stop-capabilities'
import { AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY } from './agent-session/agent-session-workspace-sleep'
import { STRUCTURED_AGENT_SESSION_SURFACE_RUNTIME_CAPABILITIES } from './structured-agent-session-surface-capabilities'

export const AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY =
  'agent-session.session-boundary.v1' as const
export const AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY =
  'agent-session.host-authority.v1' as const
// Older launch schemas reject unknown fields; advertise before clients send keyboard support.
export const AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY = 'agent-session.keyboard.v1' as const
export const AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY =
  'agent-session.omp-resume-path.v1' as const
// Why: structured sessions are journal-backed, not PTY-backed, so an incapable client must not
// receive their journal or drive their lifecycle. Mobile may receive a metadata-only placeholder;
// the host still refuses agentSession.* methods and destructive tab mutations without capability.
export const STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY = 'agent-session.structured.v1' as const
// Why: hosts before this gated `agentSession.*` on their own chat setting while still advertising
// agent-session.structured.v1, so that capability alone cannot tell a client its chat will be
// admitted. A host advertising this admits by client capability alone; a client advertising it
// picks each launch's mode itself. A client without it asks `agentSession.createSupport` to pick
// for it (released phones), so the host keeps answering that with its own setting.
export const STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY =
  'agent-session.structured.client-launch-mode.v1' as const
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
// Why: `agentSession.send`'s params are strict, so an older host rejects `delivery`; and only a
// capable client can render the `queued` result arm. It gates `delivery: 'queue-if-active'` and
// the client's queueing setting and chord, never the published draft list or its card actions: a
// host without it still publishes a message it kept unsent across a restart or a close, and both
// clients show that card and call its actions. DARK ON PURPOSE — not in
// AGENT_SESSION_RUNTIME_CAPABILITIES: advertising still requires the integrated Codex steer matrix (#21062) in the shipped host.
// v1 includes `submission.queuedMessageId` on every draft hand-off: a client reads that link and
// never compares a draft id with a submission id. It also publishes the queue's pause once, as
// `queuePause` beside the list, lifted by `agentSession.queuedMessagesResume` or any turn sent
// after it starting; while it is set every waiting card waits. `nextQueuedMessageId` beside the list
// names the card the queue sends next once nothing runs, null while anything holds it; absent (an
// older host) reads as null. A card carries a hold of its own when its conversion failed
// (`send_failed`) or the host kept it unsent (`kept`). The host mechanism lands first; the constant
// gates the rollout.
export const AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY =
  'agent-session.queued-messages.v1' as const
// Why: a host advertising this edits a queued card in place (`agentSession.queuedMessageUpdate`)
// and holds it from automatic delivery while edited (`agentSession.queuedMessageEditHold`). Apart
// from queued-messages.v1: kept and agent-mail cards are editable with mid-turn queueing still off.
// A client offers Edit only when the host advertises it; there is no copy-and-delete fallback.
export const AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY =
  'agent-session.queued-message-edit.v1' as const
// Why: `agentSession.queuedMessageUpdate`'s params are strict, so an older host rejects `images`.
// A host advertising this replaces a queued card's image set on Save; otherwise Save is text only.
export const AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY =
  'agent-session.queued-message-image-edit.v1' as const
// Why: a client advertising this shows a queued card's images and edits its text in place, keeping
// them. Released readers show only a card's text and edit by copying it and deleting the card, which
// would drop the images, so the host publishes no card holding an image to a reader without it.
export const AGENT_SESSION_QUEUED_IMAGE_CARDS_CLIENT_CAPABILITY =
  'agent-session.queued-image-cards.v1' as const
// Why: `agentSession.conversationCommand`'s params are strict, so an older host rejects
// `delivery`. A host advertising this holds a /compact sent while the agent works as a queued
// card instead of refusing it. Clients ask only when queued-messages.v1 is advertised too:
// the card is the only place the waiting command shows.
export const AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY =
  'agent-session.queued-commands.v1' as const
// Why: paired clients advertise Claude-structured support so the host can gate its agent-specific
// journal and lifecycle surfaces independently from Codex support.
export const CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY =
  'agent-session.structured.claude.v1' as const
// Why: agentSession.conversationOutline is additive; a client probes this before calling so an
// older host leaves the message rail on loaded messages instead of answering method_not_found.
export const AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY =
  'agent-session.conversation-outline.v1' as const
// Why: agentSession.item is additive; a client probes this before offering "Show full output" so an
// older host, whose rows keep only a head, is never asked for more.
export const AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY = 'agent-session.item-detail.v1' as const
// The RPC is registered unconditionally; per-session rewind support is a separate check.
export const AGENT_SESSION_REWIND_RUNTIME_CAPABILITY = 'agent-session.rewind.v1' as const
// Why: the rewind UI relies on the next send settling an in-doubt rewind, even with the agent up.
export const AGENT_SESSION_REWIND_RECOVERY_CAPABILITY = 'agent-session.rewind-recovery.v1' as const
// Readers must understand a monitoring roster with no available stop control.
// Why: a `turn` journal item replaced the status row that used to carry a turn's lifecycle. A
// client that predates it would render the unknown kind as text, so the host publishes the legacy
// status form to clients that do not advertise this. Transitional: drop the downgrade once no
// supported release lacks the capability.
export const AGENT_SESSION_TURN_ITEM_CAPABILITY = 'agent-session.turn-item.v1' as const
/** The client retires acknowledged echoes even when a catch-up snapshot skips their rows. */
export const AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY =
  'agent-session.snapshot-catch-up.v1' as const
export const AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY =
  'agent-session.background-task-stop.v1' as const
// Why: agentSession.respondToQuestion has a strict schema, so clients must not send structured
// `answers` to an older host; they fall back to the answer packed into `optionId`.
export const AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY =
  'agent-session.question-answers.v1' as const
// Why: a structured chat on a paired server stores attached files on that server
// (agentSessionAttachment.*); an older server has no store, so clients must refuse
// the attach rather than hand the agent a path from this machine.
export const AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY = 'agent-session.attachments.v1' as const
// Why: hosts before this advertise attachments.v1 but refuse the upload methods from a phone.
export const AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY =
  'agent-session.attachments.phone.v1' as const
// Why: the host now publishes rows for work that is live inside a turn, and such
// a row carries `stoppable: false` because no targeted stop can reach it. A
// reader that predates the field draws a per-row Stop on every row it is given,
// so it must be told apart from one that honours the field — and NOT by the
// stop capability above, which a client can advertise while predating this.
export const AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY =
  'agent-session.background-task-row-stop.v1' as const

export const AGENT_SESSION_RUNTIME_CAPABILITIES = [
  ...AGENT_SESSION_STOP_RUNTIME_CAPABILITIES,
  ...AGENT_SESSION_CREATE_RUNTIME_CAPABILITIES,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  // The host side: it accepts a send before any agent has it, and a Stop with no writer before a
  // turn starts, so a client may gate on either.
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY,
  AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY,
  ...STRUCTURED_AGENT_SESSION_SURFACE_RUNTIME_CAPABILITIES,
  ...AGENT_SESSION_ATTENTION_RUNTIME_CAPABILITIES,
  AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RECOVERY_CAPABILITY,
  AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY,
  AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY,
  AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY,
  ...AGENT_SESSION_RESUME_RUNTIME_CAPABILITIES
] as const
