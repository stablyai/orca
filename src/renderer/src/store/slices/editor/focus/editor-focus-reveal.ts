import type { PendingEditorReveal } from '../types/pending-editor-reveal'
import type { AppState } from '../../../types'
import '../types/pending-editor-reveal'

export let nextEditorFocusRequestToken = 0

export function takeNextEditorFocusRequestToken(): number {
  return ++nextEditorFocusRequestToken
}

const pendingEditorLineRevealFrameIds = new Set<number>()
let dropPendingEditorLineReveal: (() => void) | undefined

export function cancelPendingEditorLineRevealFrames(): void {
  const drop = dropPendingEditorLineReveal
  dropPendingEditorLineReveal = undefined
  drop?.()
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
  fileId?: string,
  options?: Pick<PendingEditorReveal, 'viewStateId' | 'canApply' | 'onApplied'> & {
    beforePublish?: () => void
    onDropped?: () => void
  }
): void {
  // Why: openFile may remount Monaco async; the reveal must land after remount or the old editor clears it.
  cancelPendingEditorLineRevealFrames()
  get().setPendingEditorReveal(null)
  dropPendingEditorLineReveal = options?.onDropped
  requestTrackedEditorLineRevealFrame(() => {
    requestTrackedEditorLineRevealFrame(() => {
      dropPendingEditorLineReveal = undefined
      if (options?.canApply?.() === false) {
        options.onDropped?.()
        return
      }
      const { beforePublish, onDropped: _onDropped, ...revealOptions } = options ?? {}
      beforePublish?.()
      get().setPendingEditorReveal({
        filePath,
        fileId,
        line,
        column: column ?? 1,
        matchLength: 0,
        ...revealOptions
      })
    })
  })
}
