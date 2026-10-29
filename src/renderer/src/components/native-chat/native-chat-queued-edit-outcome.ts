import type { AgentSessionQueuedMessageUpdateResult } from '../../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import type { StructuredAgentSessionWriteOutcome } from './use-structured-agent-session-mutate'
import type {
  NativeChatQueuedEditSession,
  NativeChatQueuedEditAttempt
} from './native-chat-queued-edit-session'
import { queuedEditStanding } from '../../../../shared/queued-message-edit'
import { nativeChatQueuedEditValueKey } from './native-chat-queued-edit-value'

type Outcome = 'close' | 'rebase' | 'gone' | 'changed' | 'refused' | 'stay'

/** Replies and publications settle only the current immutable attempt. */
export function settleNativeChatQueuedEdit(
  edit: NativeChatQueuedEditSession,
  attempt = edit.attempt,
  result?: StructuredAgentSessionWriteOutcome<AgentSessionQueuedMessageUpdateResult>
): Outcome {
  if (edit.closed || edit.attempt !== attempt) {
    return 'stay'
  }
  const loss =
    edit.leaseLoss?.lease === edit.lease && edit.leaseLoss.expected === edit.baseFingerprint
      ? edit.leaseLoss.status
      : undefined
  const lost = loss === 'changed' ? 'changed' : loss ? 'gone' : undefined
  const standing = queuedEditStanding(
    edit.view,
    edit.sessionId,
    edit.messageId,
    attempt?.fingerprint ?? null
  )
  let proof = !result && (standing === 'holds' || standing === 'sent')
  if (result?.kind === 'done') {
    const status = result.value.status
    if (status === 'gone' || status === 'changed') {
      edit.attempt = undefined
      return status
    }
    if (status !== 'updated' && status !== 'unchanged') {
      edit.attempt = undefined
      return lost ?? (edit.pendingClose || standing === 'gone' ? 'gone' : 'refused')
    }
    proof = result.value.fingerprint === attempt?.fingerprint
    if (!proof && attempt) {
      attempt.phase = 'unknown'
      edit.uncertain ||= attempt.fingerprint !== attempt.expected
    }
  } else if (result) {
    if (result.kind === 'dropped' || result.failure.kind !== 'unconfirmed') {
      edit.attempt = undefined
      return lost ?? (edit.pendingClose || standing === 'gone' ? 'gone' : 'refused')
    }
    if (attempt) {
      attempt.phase = 'unknown'
      edit.uncertain ||= attempt.fingerprint !== attempt.expected
    }
    proof = standing === 'holds' || standing === 'sent'
  }
  if (attempt && proof) {
    // An unchanged observation cannot exclude an older divergent CAS write from the same base.
    if (edit.uncertain && attempt.fingerprint === edit.baseFingerprint) {
      attempt.phase = 'unknown'
      return lost ?? (edit.pendingClose || standing === 'sent' ? 'gone' : 'stay')
    }
    const equal = nativeChatQueuedEditValueKey(edit.scopeKey) === attempt.key
    rebaseNativeChatQueuedEdit(edit, attempt)
    if (equal) {
      return 'close'
    }
    return edit.pendingClose ||
      standing === 'sent' ||
      standing === 'gone' ||
      loss === 'gone' ||
      loss === 'not-editable'
      ? 'gone'
      : loss === 'changed' && attempt.fingerprint === attempt.expected
        ? 'changed'
        : 'rebase'
  }
  if (lost) {
    return lost
  }
  if (standing === 'gone' || edit.pendingClose) {
    return 'gone'
  }
  const listed = edit.view.messages?.find((entry) => entry.messageId === edit.messageId)
  if (
    !result &&
    listed &&
    agentSessionSendBodyFingerprint(edit.sessionId, listed.body) !== edit.baseFingerprint
  ) {
    return 'changed'
  }
  return 'stay'
}

function rebaseNativeChatQueuedEdit(
  edit: NativeChatQueuedEditSession,
  attempt: NativeChatQueuedEditAttempt
): void {
  const blocks = attempt.body.blocks.filter((block) => block.type === 'image-ref')
  edit.kept = attempt.draft.images.flatMap((image, index) =>
    blocks[index] ? [{ id: image.id, image, block: blocks[index] }] : []
  )
  edit.baseKey = attempt.key
  edit.initial = attempt.draft
  edit.body = attempt.body
  edit.baseFingerprint = attempt.fingerprint
  edit.uncertain = false
  edit.attempt = undefined
}
