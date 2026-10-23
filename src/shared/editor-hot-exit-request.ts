import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  ORCA_EDITOR_PREPARE_HOT_EXIT_REPLY_EVENT,
  type EditorPrepareHotExitReply,
  type EditorPrepareHotExitRequest
} from './editor-save-events'

export type EditorHotExitResponder = {
  userInitiated: boolean
  resolve: () => void
  reject: (message: string) => void
}

function eventDetail(event: Event): unknown {
  return 'detail' in event ? event.detail : undefined
}

function isHotExitRequest(value: unknown): value is EditorPrepareHotExitRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'requestId' in value &&
    typeof value.requestId === 'string' &&
    'userInitiated' in value &&
    typeof value.userInitiated === 'boolean'
  )
}

function isHotExitReply(value: unknown): value is EditorPrepareHotExitReply {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('requestId' in value) || typeof value.requestId !== 'string' || !('kind' in value)) {
    return false
  }
  return (
    value.kind === 'claimed' ||
    value.kind === 'resolved' ||
    (value.kind === 'rejected' && 'message' in value && typeof value.message === 'string')
  )
}

/** Asks the renderer's editor owner to make unsaved buffers safe for a restart. */
export function requestEditorHotExitBackup(
  eventTarget: EventTarget,
  userInitiated: boolean
): Promise<void> {
  // Why random: the preload world and the page world each send requests on the same window.
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    let claimed = false
    const onReply = (event: Event): void => {
      const reply = eventDetail(event)
      if (!isHotExitReply(reply) || reply.requestId !== requestId) {
        return
      }
      if (reply.kind === 'claimed') {
        claimed = true
        return
      }
      eventTarget.removeEventListener(ORCA_EDITOR_PREPARE_HOT_EXIT_REPLY_EVENT, onReply)
      if (reply.kind === 'rejected') {
        reject(new Error(reply.message))
        return
      }
      resolve()
    }
    eventTarget.addEventListener(ORCA_EDITOR_PREPARE_HOT_EXIT_REPLY_EVENT, onReply)
    eventTarget.dispatchEvent(
      new CustomEvent<EditorPrepareHotExitRequest>(ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT, {
        detail: { requestId, userInitiated }
      })
    )

    // Why: restart paths can run before the editor autosave controller mounts.
    // With no claimant, there are no renderer-owned dirty buffers to back up.
    if (!claimed) {
      eventTarget.removeEventListener(ORCA_EDITOR_PREPARE_HOT_EXIT_REPLY_EVENT, onReply)
      resolve()
    }
  })
}

/** Claims a hot-exit request synchronously; must be called inside the event's listener. */
export function acceptEditorHotExitRequest(event: Event): EditorHotExitResponder | null {
  const request = eventDetail(event)
  const target = event.currentTarget
  if (!isHotExitRequest(request) || !target) {
    return null
  }
  const reply = (detail: EditorPrepareHotExitReply): void => {
    target.dispatchEvent(
      new CustomEvent<EditorPrepareHotExitReply>(ORCA_EDITOR_PREPARE_HOT_EXIT_REPLY_EVENT, {
        detail
      })
    )
  }
  reply({ requestId: request.requestId, kind: 'claimed' })
  return {
    userInitiated: request.userInitiated,
    resolve: () => reply({ requestId: request.requestId, kind: 'resolved' }),
    reject: (message) => reply({ requestId: request.requestId, kind: 'rejected', message })
  }
}
