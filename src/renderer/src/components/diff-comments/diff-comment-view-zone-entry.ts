import type { editor as monacoEditor } from 'monaco-editor'
import type { Root } from 'react-dom/client'

export type ZoneEntry = {
  zoneId: string
  domNode: HTMLElement
  // Hold the delegate so layoutZone re-reads our updated heightInPx — mutating the delegate is the supported way to resize a zone in place.
  delegate: monacoEditor.IViewZone
  root: Root
  disposeMouseDownStopper: () => void
  lastRenderSignature: string
  // First onDomNodeTop = deterministic "zone laid out" signal; gates scroll-to-note instead of polling getTopForLineNumber.
  laidOut: boolean
}

// Card chrome + per-line body height; used by the initial estimate and the live resize, so keep in lockstep.
export const ZONE_CHROME_PX = 68
export const ZONE_LINE_PX = 20
export const ZONE_MIN_PX = 88

// Re-measure/re-layout the zone: mutate delegate.heightInPx first (Monaco's _layoutZone re-reads it) so inline edit expands without clipping.
export function resizeDiffCommentZone(editor: monacoEditor.ICodeEditor, entry: ZoneEntry): void {
  const child = entry.domNode.firstElementChild
  const wrapperStyle = window.getComputedStyle(entry.domNode)
  const verticalPadding =
    Number.parseFloat(wrapperStyle.paddingTop) + Number.parseFloat(wrapperStyle.paddingBottom)
  // Monaco pins the zone node to its previous height (scrollHeight can't shrink), so measure the rendered card+padding to allow collapse.
  const childHeight = child?.getBoundingClientRect().height ?? 0
  // React can commit while Monaco's zone is detached; preserve the safe
  // initial estimate until the observer sees a measurable card.
  if (childHeight <= 0) {
    return
  }
  const measured = Math.ceil(childHeight + verticalPadding)
  if (entry.delegate.heightInPx === measured) {
    return
  }
  entry.delegate.heightInPx = measured
  editor.changeViewZones((acc) => {
    acc.layoutZone(entry.zoneId)
  })
}
