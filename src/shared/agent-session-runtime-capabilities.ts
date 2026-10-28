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
// Gate journal/lifecycle/destructive tab mutations by client capability. Mobile may receive metadata-only placeholders for these non-PTY sessions.
export const STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY = 'agent-session.structured.v1' as const
// Older hosts advertised structured.v1 while gating on their setting. This capability gives clients per-launch mode choice; legacy clients use createSupport, which retains the host setting.
export const STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY =
  'agent-session.structured.client-launch-mode.v1' as const
// Capable clients understand durable pending replies and skip bounded host settlement observation; older clients render uncertainty.
export const AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY =
  'agent-session.pending-send-result.v1' as const
// Early acceptance requires clients to display later rejection. Hold legacy replies until handover/rejection; remove only after supported desktop/mobile clients render rejected messages in place.
export const AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY =
  'agent-session.accepted-send.v1' as const
// Capable hosts answer resend IDs from the record before other refusals; only returned answers
// prove anything, never throws (even refusals). operation_unknown + outcomeUnknown/resultLost
// means retry the same ID; rewindUnconfirmed means settled with no write. operation_expired needs
// transcript inspection; operation_conflict/messageIdReused/sessionNotAttached prove no outcome.
// Other refusals prove no recorded/in-flight message, but resending that ID could still run it:
// after returning text to the user, never resend the old ID. Older hosts provide none of these guarantees.
export const AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY =
  'agent-session.send-answers-proof.v1' as const
// Older hosts reject delivery; older clients cannot render queued replies. Gate queue-if-active,
// its setting and chord, but never kept-draft lists/actions. DARK until the shipped host passes
// the integrated Codex steer matrix (#21062); keep out of AGENT_SESSION_RUNTIME_CAPABILITIES.
// v1 links hand-offs via submission.queuedMessageId, never equal draft/submission IDs. queuePause
// holds every card until queuedMessagesResume or a later turn starts. nextQueuedMessageId names
// the next eligible card; null/missing means none. Per-card holds: send_failed conversion or kept.
// Host mechanisms land first; this capability gates rollout.
export const AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY =
  'agent-session.queued-messages.v1' as const
// Advertise in-place update/edit holds separately from mid-turn queueing: kept/mail cards remain editable while queueing is off. Never fall back to copy/delete.
export const AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY =
  'agent-session.queued-message-edit.v1' as const
export const AGENT_SESSION_QUEUED_MESSAGE_REORDER_RUNTIME_CAPABILITY =
  'agent-session.queued-message-reorder.v1' as const
// Update params are strict: send images only when advertised; otherwise Save edits text alone.
export const AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY =
  'agent-session.queued-message-image-edit.v1' as const
// Publish image cards only to capable readers that preserve images on edit; older copy/delete editing would lose them.
export const AGENT_SESSION_QUEUED_IMAGE_CARDS_CLIENT_CAPABILITY =
  'agent-session.queued-image-cards.v1' as const
// Strict conversationCommand rejects unknown delivery. Offer queued /compact only with this and queued-messages.v1; its card is the sole waiting surface.
export const AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY =
  'agent-session.queued-commands.v1' as const
// Gate Claude journal/lifecycle independently of Codex for paired clients.
export const CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY =
  'agent-session.structured.claude.v1' as const
// Probe additive conversationOutline before calling; older hosts keep loaded-message rails instead of method_not_found.
export const AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY =
  'agent-session.conversation-outline.v1' as const
export const AGENT_SESSION_CONTINUATION_CONTEXT_RUNTIME_CAPABILITY =
  'agent-session.continuation-context.v1' as const
// Probe additive item reads before offering full output; older hosts retain only heads.
export const AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY = 'agent-session.item-detail.v1' as const
// The RPC is registered unconditionally; per-session rewind support is a separate check.
export const AGENT_SESSION_REWIND_RUNTIME_CAPABILITY = 'agent-session.rewind.v1' as const
// Why: the rewind UI relies on the next send settling an in-doubt rewind, even with the agent up.
export const AGENT_SESSION_REWIND_RECOVERY_CAPABILITY = 'agent-session.rewind-recovery.v1' as const
// Readers must understand a monitoring roster with no available stop control.
// Downgrade turn items to legacy status rows for incapable clients; remove only after every supported release understands turn items.
export const AGENT_SESSION_TURN_ITEM_CAPABILITY = 'agent-session.turn-item.v1' as const
/** The client retires acknowledged echoes even when a catch-up snapshot skips their rows. */
export const AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY =
  'agent-session.snapshot-catch-up.v1' as const
export const AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY =
  'agent-session.background-task-stop.v1' as const
// Question-answer params are strict: older hosts need packed optionId instead of structured answers.
export const AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY =
  'agent-session.question-answers.v1' as const
// Paired attachments belong on the server; refuse unsupported servers instead of passing local machine paths.
export const AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY = 'agent-session.attachments.v1' as const
// Why: hosts before this advertise attachments.v1 but refuse the upload methods from a phone.
export const AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY =
  'agent-session.attachments.phone.v1' as const
// Readers must explicitly honor stoppable:false on live child rows. The Stop capability alone predates this field and cannot prove safe rendering.
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
  AGENT_SESSION_QUEUED_MESSAGE_REORDER_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY,
  AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY,
  ...STRUCTURED_AGENT_SESSION_SURFACE_RUNTIME_CAPABILITIES,
  ...AGENT_SESSION_ATTENTION_RUNTIME_CAPABILITIES,
  AGENT_SESSION_WORKSPACE_SLEEP_MARK_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RECOVERY_CAPABILITY,
  AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONTINUATION_CONTEXT_RUNTIME_CAPABILITY,
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
