import type { editor } from 'monaco-editor'
import { getCombinedDiffExtent } from './combined-diff-extent-dom'
import type { CombinedDiffItemAnchor } from './combined-diff-extent'
import {
  COMBINED_DIFF_HEADER_SELECTOR,
  COMBINED_DIFF_ROW_SELECTOR,
  COMBINED_DIFF_VIEWPORT_SELECTOR
} from './combined-diff-viewport'
import { getCombinedDiffSlice, resolveCombinedDiffReveal } from './combined-diff-slice-geometry'
import { registerCombinedDiffNavigation } from './combined-diff-navigation'

export function installCombinedDiffSlice(
  diff: editor.IStandaloneDiffEditor,
  body: HTMLElement,
  publishExtent: (height: number) => void
): () => void {
  const viewport = body.closest<HTMLElement>(COMBINED_DIFF_VIEWPORT_SELECTOR)
  const host = diff.getContainerDomNode().parentElement
  if (!viewport || !host) {
    return () => {}
  }
  const row = body.closest<HTMLElement>(COMBINED_DIFF_ROW_SELECTOR)
  if (!row) {
    return () => {}
  }
  const owner = getCombinedDiffExtent(viewport)
  const index = (): number => Number(row.dataset.index)
  const header = row.querySelector<HTMLElement>(COMBINED_DIFF_HEADER_SELECTOR)
  const panes = [diff.getOriginalEditor(), diff.getModifiedEditor()]
  let disposed = false
  let transaction = 0
  let frame = 0
  let revision = 0
  let queued = false
  let pending: {
    request: Exclude<editor.IEditorRevealRequest, { kind: 'save' }>
    pane: editor.ICodeEditor
  } | null = null
  const snapshots = new WeakMap<
    editor.ICodeEditorViewState,
    { model: editor.ITextModel; anchor: CombinedDiffItemAnchor }
  >()
  let delta = 0
  let width = -1
  let height = -1
  const applied = new Map(panes.map((pane) => [pane, pane.getScrollTop()]))
  const headerHeight = (): number => header?.getBoundingClientRect().height ?? 0
  const bodyOffset = (): number =>
    body.getBoundingClientRect().top - row.getBoundingClientRect().top
  const bodyTop = (): number => (owner.item(index())?.start ?? 0) + bodyOffset()
  const paneOrigin = (pane: editor.ICodeEditor): number =>
    Number.parseFloat(host.style.top || '0') - (applied.get(pane) ?? 0)
  const acknowledge = (action: () => void): void => {
    transaction += 1
    try {
      action()
    } finally {
      panes.forEach((pane) => applied.set(pane, pane.getScrollTop()))
      transaction -= 1
    }
  }
  const forward = (): void => {
    if (disposed || !viewport.clientHeight || !body.clientWidth) {
      return
    }
    const content = Math.max(...panes.map((pane) => pane.getContentHeight()))
    const slice = getCombinedDiffSlice(
      content,
      viewport.clientHeight,
      headerHeight(),
      bodyTop(),
      viewport.scrollTop
    )
    host.style.position = 'absolute'
    host.style.top = `${slice.offset}px`
    host.style.width = '100%'
    host.style.height = `${slice.height}px`
    const visibleTop = bodyTop() + slice.offset - viewport.scrollTop
    host.style.visibility =
      visibleTop < viewport.clientHeight && visibleTop + slice.height > headerHeight()
        ? ''
        : 'hidden'
    acknowledge(() => {
      if (width !== body.clientWidth || height !== slice.height) {
        width = body.clientWidth
        height = slice.height
        diff.layout({ width, height })
      }
      diff.getModifiedEditor().setScrollTop(slice.offset, 1, 'geometry')
    })
  }
  const commit = (target: number): boolean => {
    const changed = owner.navigate(target)
    forward()
    return changed
  }
  const reveal = (top: number, bottom: number, policy: number, minimal = false): void => {
    commit(
      resolveCombinedDiffReveal(
        viewport.scrollTop,
        viewport.clientHeight,
        headerHeight(),
        bodyTop() + top,
        bodyTop() + bottom,
        policy,
        minimal
      )
    )
  }
  const cancelPending = (): void => {
    revision += 1
    pending = null
    delta = 0
  }
  const schedule = (): void => {
    if (queued) {
      return
    }
    queued = true
    const scheduledRevision = revision
    queueMicrotask(() => {
      queued = false
      if (disposed) {
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
      const requestedPane = operation?.pane
      const currentModel = requestedPane?.getModel()
      if (request && requestedPane && currentModel === request.model) {
        if (request.kind === 'anchor') {
          acknowledge(() =>
            owner.transact(index(), request.delta, () => {
              publishExtent(Math.max(...panes.map((pane) => pane.getContentHeight())))
              return !disposed && requestedPane.getModel() === request.model
            })
          )
          forward()
        } else if (request.kind === 'restore') {
          const snapshot = snapshots.get(request.state)
          if (snapshot?.model === request.model) {
            owner.restore({
              ...snapshot.anchor,
              offset: bodyOffset() + requestedPane.getScrollTop()
            })
          }
          forward()
        } else if (request.kind === 'find') {
          forward()
          const top = Number.parseFloat(host.style.top || '0')
          reveal(top, top + request.height, 0)
        } else if (request.source === 'restoreState' || request.source === 'modelChange') {
          forward()
        } else {
          forward()
          const origin = paneOrigin(requestedPane)
          reveal(
            request.top + origin,
            request.bottom + origin,
            request.verticalType,
            request.minimal
          )
        }
      } else if (scrollDelta) {
        commit(viewport.scrollTop + scrollDelta)
      }
    })
  }
  const geometryChanged = (): void => {
    panes.forEach((pane) => applied.set(pane, pane.getScrollTop()))
    if (!transaction && !frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        forward()
      })
    }
  }
  const subscriptions = panes.flatMap((pane) =>
    [
      pane.onDidRequestReveal((request) => {
        if (request.kind === 'save') {
          const anchor = owner.capture(index(), bodyOffset() + pane.getScrollTop())
          if (anchor) {
            snapshots.set(request.state, { model: request.model, anchor })
          }
          return
        }
        if (transaction) {
          return
        }
        pending = { request, pane }
        schedule()
      }),
      pane.onDidScrollChange((event) => {
        if (transaction) {
          return
        }
        if (event.scrollSource === 'geometry') {
          geometryChanged()
          return
        }
        if (!event.scrollTopChanged) {
          return
        }
        // Read peers after synchronization; their following outgoing event is an acknowledgement.
        const change = event.scrollTopDelta
        panes.forEach((peer) => applied.set(peer, peer.getScrollTop()))
        if (change) {
          delta += change
          schedule()
        }
      }),
      pane.onDidChangeModel(() => {
        cancelPending()
      }),
      pane.onDidContentSizeChange(geometryChanged),
      pane.onDidChangeHiddenAreas(geometryChanged),
      pane.onDidChangeViewZones(geometryChanged),
      pane.onDidLayoutChange(geometryChanged),
      registerCombinedDiffNavigation(pane.getContainerDomNode(), {
        reveal: (top, bottom, policy) => {
          cancelPending()
          forward()
          const origin = paneOrigin(pane)
          reveal(top + origin, bottom + origin, policy)
        },
        scrollBy: (amount) => {
          cancelPending()
          const edge =
            amount > 0
              ? bodyTop() +
                Math.max(...panes.map((pane) => pane.getContentHeight())) -
                viewport.clientHeight
              : bodyTop() - headerHeight()
          const target =
            amount > 0
              ? Math.min(viewport.scrollTop + amount, Math.max(viewport.scrollTop, edge))
              : Math.max(viewport.scrollTop + amount, Math.min(viewport.scrollTop, edge))
          return commit(target)
        }
      })
    ].map((subscription) =>
      typeof subscription === 'function' ? { dispose: subscription } : subscription
    )
  )
  const resize = new ResizeObserver(() => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        forward()
      })
    }
  })
  resize.observe(body)
  resize.observe(viewport)
  viewport.addEventListener('scroll', forward, { passive: true })
  const inputs = ['wheel', 'touchmove', 'pointerdown'] as const
  inputs.forEach((type) =>
    viewport.addEventListener(type, cancelPending, { capture: true, passive: true })
  )
  forward()
  return () => {
    disposed = true
    cancelPending()
    cancelAnimationFrame(frame)
    resize.disconnect()
    viewport.removeEventListener('scroll', forward)
    inputs.forEach((type) => viewport.removeEventListener(type, cancelPending, true))
    subscriptions.forEach((subscription) => subscription.dispose())
  }
}
