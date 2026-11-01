import type { editor } from 'monaco-editor'
import type { CombinedDiffExtent, CombinedDiffItemAnchor } from './combined-diff-extent'

export function createCombinedDiffNativeReveal(
  owner: CombinedDiffExtent,
  geometry: {
    index: () => number
    bodyOffset: () => number
    paneOrigin: (pane: editor.ICodeEditor) => number
    hostTop: () => number
    scrollTop: () => number
    forward: () => void
    reveal: (top: number, bottom: number, policy: number, minimal?: boolean) => void
    commit: (target: number) => boolean
    disposed: () => boolean
  }
) {
  const snapshots = new WeakMap<
    editor.ICodeEditorViewState,
    { model: editor.ITextModel; anchor: CombinedDiffItemAnchor }
  >()
  let pending: {
    request: Exclude<editor.IEditorRevealRequest, { kind: 'save' }>
    pane: editor.ICodeEditor
  } | null = null
  let revision = 0
  let queued = false
  let delta = 0
  const schedule = (): void => {
    if (queued) {
      return
    }
    queued = true
    const scheduledRevision = revision
    queueMicrotask(() => {
      queued = false
      if (geometry.disposed()) {
        return
      }
      if (scheduledRevision !== revision) {
        if (pending || delta) {
          schedule()
        }
        return
      }
      const operation = pending
      const request = operation?.request
      const scrollDelta = delta
      pending = null
      delta = 0
      const pane = operation?.pane
      if (request && pane && pane.getModel() === request.model) {
        if (request.kind === 'restore') {
          const snapshot = snapshots.get(request.state)
          if (snapshot?.model === request.model) {
            owner.restore({
              ...snapshot.anchor,
              offset: geometry.bodyOffset() + pane.getScrollTop()
            })
          }
          geometry.forward()
        } else if (request.kind === 'find') {
          geometry.forward()
          const top = geometry.hostTop()
          geometry.reveal(top, top + request.height, 0)
        } else if (request.source === 'restoreState' || request.source === 'modelChange') {
          geometry.forward()
        } else {
          geometry.forward()
          const origin = geometry.paneOrigin(pane)
          geometry.reveal(
            request.top + origin,
            request.bottom + origin,
            request.verticalType,
            request.minimal
          )
        }
      } else if (scrollDelta) {
        geometry.commit(geometry.scrollTop() + scrollDelta)
      }
    })
  }
  return {
    cancel: (): void => {
      revision += 1
      pending = null
      delta = 0
    },
    scroll: (change: number): void => {
      delta += change
      schedule()
    },
    request: (pane: editor.ICodeEditor, request: editor.IEditorRevealRequest): void => {
      if (request.kind === 'save') {
        const anchor = owner.capture(geometry.index(), geometry.bodyOffset() + pane.getScrollTop())
        if (anchor) {
          snapshots.set(request.state, { model: request.model, anchor })
        }
        return
      }
      pending = { pane, request }
      schedule()
    }
  }
}
