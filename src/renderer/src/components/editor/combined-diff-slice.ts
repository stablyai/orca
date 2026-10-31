import type { editor } from 'monaco-editor'
import { getCombinedDiffExtent } from './combined-diff-extent-dom'
import type { CombinedDiffItemAnchor } from './combined-diff-extent'
import {
  COMBINED_DIFF_HEADER_SELECTOR,
  COMBINED_DIFF_ROW_SELECTOR,
  COMBINED_DIFF_VIEWPORT_SELECTOR
} from './combined-diff-viewport'
import {
  createCombinedDiffSliceLayout,
  resolveCombinedDiffReveal
} from './combined-diff-slice-geometry'
import { registerCombinedDiffNavigation } from './combined-diff-navigation'
import { createCombinedDiffExpansion } from './combined-diff-expansion'
import { getMeasuredDiffSectionBodyHeight } from './diff-section-layout'

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
  let preparingExpansion = false
  const forward = createCombinedDiffSliceLayout(diff, body, host, viewport, {
    contentHeight: () =>
      preparingExpansion
        ? Math.max(...panes.map((pane) => pane.getContentHeight()))
        : Math.max(1, Number.parseFloat(body.style.height) - getMeasuredDiffSectionBodyHeight(0)) ||
          Math.max(...panes.map((pane) => pane.getContentHeight())),
    headerHeight,
    bodyTop,
    acknowledge,
    disposed: () => disposed
  })
  const expansion = createCombinedDiffExpansion(owner, {
    index,
    body,
    row,
    panes,
    point: (pane, line) =>
      bodyOffset() +
      Number.parseFloat(host.style.top || '0') +
      (line > (pane.getModel()?.getLineCount() ?? 0)
        ? pane.getContentHeight()
        : pane.getTopForLineNumber(line)) -
      pane.getScrollTop(),
    prepare: (target) => {
      preparingExpansion = true
      try {
        forward(target)
      } finally {
        preparingExpansion = false
      }
    },
    publish: publishExtent,
    acknowledge
  })
  const updateGeometry = (): void => {
    if (!expansion.reconcile()) {
      forward()
    }
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
    expansion.cancel()
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
        if (request.kind === 'restore') {
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
        updateGeometry()
      })
    }
  }
  const subscriptions = panes.flatMap((pane) =>
    [
      pane.setScrollAnchorHandler((request) => {
        revision += 1
        pending = null
        delta = 0
        const claimed = expansion.run(pane, request)
        if (claimed) {
          updateGeometry()
        }
        return claimed
      }),
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
        expansion.cancel()
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
          expansion.cancel()
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
        updateGeometry()
      })
    }
  })
  resize.observe(body)
  resize.observe(viewport)
  viewport.addEventListener('scroll', updateGeometry, { passive: true })
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
    viewport.removeEventListener('scroll', updateGeometry)
    inputs.forEach((type) => viewport.removeEventListener(type, cancelPending, true))
    subscriptions.forEach((subscription) => subscription.dispose())
  }
}
