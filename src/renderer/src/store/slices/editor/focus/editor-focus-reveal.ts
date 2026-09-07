import type { AppState } from '../../../types'
import { EDITOR_FOCUS_REQUEST_TTL_MS } from '../types/pending-editor-reveal'

export { EDITOR_FOCUS_REQUEST_TTL_MS }

export let nextEditorFocusRequestToken = 0

export function takeNextEditorFocusRequestToken(): number {
  return ++nextEditorFocusRequestToken
}

const pendingEditorLineRevealFrameIds = new Set<number>()

export function cancelPendingEditorLineRevealFrames(): void {
  if (typeof cancelAnimationFrame === 'function') {
    for (const frameId of pendingEditorLineRevealFrameIds) {
      cancelAnimationFrame(frameId)
    }
  }
  pendingEditorLineRevealFrameIds.clear()
}

function trackEditorLineRevealFrameId(frameId: number): void {
  pendingEditorLineRevealFrameIds.add(frameId)
}

function requestTrackedEditorLineRevealFrame(callback: FrameRequestCallback): void {
  let completed = false
  let frameId: number | undefined
  frameId = requestAnimationFrame((timestamp) => {
    completed = true
    if (frameId !== undefined) {
      pendingEditorLineRevealFrameIds.delete(frameId)
    }
    callback(timestamp)
  })
  if (!completed) {
    trackEditorLineRevealFrameId(frameId)
  }
}

export function scheduleEditorLineReveal(
  get: () => AppState,
  filePath: string,
  line: number,
  column?: number,
  fileId?: string
): void {
  // Why: openFile may remount Monaco async; the reveal must land after remount or the old editor clears it.
  cancelPendingEditorLineRevealFrames()
  get().setPendingEditorReveal(null)
  requestTrackedEditorLineRevealFrame(() => {
    requestTrackedEditorLineRevealFrame(() => {
      get().setPendingEditorReveal({
        filePath,
        fileId,
        line,
        column: column ?? 1,
        matchLength: 0
      })
    })
  })
}
