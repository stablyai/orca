import type {
  PipelineV2BoundSessionInput,
  PipelineV2BoundSessionResult
} from '../../../../shared/pipelines/v2/pipeline-v2-session-contracts'

const pending = new Map<
  string,
  {
    input: PipelineV2BoundSessionInput
    handled: boolean
    sending?: Promise<PipelineV2BoundSessionResult>
  }
>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())
export function subscribePipelineDiscussionSends(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function pipelineDiscussionPending(sessionId?: string, ptyId?: string | null) {
  return Boolean(
    (sessionId && pending.has(`session:${sessionId}`)) || (ptyId && pending.has(`pty:${ptyId}`))
  )
}
export async function sendPipelineSessionDiscussion(
  input: PipelineV2BoundSessionInput
): Promise<PipelineV2BoundSessionResult> {
  if (JSON.stringify(input.message).length > 4000 || input.hasAttachments) {
    return window.api.pipelineOwner.discussBoundSession(input)
  }
  const key = input.sessionId ? `session:${input.sessionId}` : `pty:${input.ptyId}`
  let entry = pending.get(key)
  if (
    entry &&
    (entry.input.message !== input.message || entry.input.hasAttachments !== input.hasAttachments)
  ) {
    throw new Error(
      'Resolve the unconfirmed pipeline message before sending another one. Your new text is retained.'
    )
  }
  if (!entry) {
    if (pending.size >= 64) {
      throw new Error('Resolve an unconfirmed pipeline message before sending to another session.')
    }
    entry = { input, handled: false }
    pending.set(key, entry)
    changed()
  }
  if (entry.sending) {
    return entry.sending
  }
  const current = entry
  current.sending = window.api.pipelineOwner
    .discussBoundSession(current.input)
    .then((result) => {
      if (!result.handled && current.handled) {
        throw new Error('Pipeline delivery is still unconfirmed. Inspect the run before retrying.')
      }
      current.handled ||= result.handled
      if (!result.handled || result.accepted || result.rejected) {
        pending.delete(key)
        changed()
      }
      return result
    })
    .finally(() => {
      current.sending = undefined
    })
  return current.sending
}
