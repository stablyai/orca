import type { editor as monacoEditor } from 'monaco-editor'
import type { Root } from 'react-dom/client'

export type ZoneEntry = {
  zoneId: string
  domNode: HTMLElement
  // Retain the delegate because Monaco re-reads its mutated heightInPx on layoutZone.
  delegate: monacoEditor.IViewZone
  root: Root
  disposeMouseDownStopper: () => void
  lastRenderSignature: string
  // Use the first onDomNodeTop as the layout signal for scroll-to-note instead of polling.
  laidOut: boolean
}

export type DraftZoneEntry = {
  editor: monacoEditor.ICodeEditor
  zoneId: string
  domNode: HTMLElement
  marginDomNode: HTMLElement
  delegate: monacoEditor.IViewZone
  root: Root
  draft: { lineNumber: number; startLine?: number }
  body: string
  // A save is in flight: the body must not be carried to another card, or the note could post twice.
  submitting: boolean
  disposeMouseDownStopper: () => void
}

// Card chrome + per-line body height; used by the initial estimate and the live resize, so keep in lockstep.
export const ZONE_CHROME_PX = 68
export const ZONE_LINE_PX = 20
export const ZONE_MIN_PX = 88
export const DRAFT_ZONE_DEFAULT_HEIGHT = 152

export type ResizableZoneEntry = {
  zoneId: string
  domNode: HTMLElement
  delegate: monacoEditor.IViewZone
}

// Resize through the delegate; Monaco re-reads heightInPx during layoutZone.
export function resizeDiffCommentZone(
  editor: monacoEditor.ICodeEditor,
  entry: ResizableZoneEntry
): void {
  const child = entry.domNode.firstElementChild
  const wrapperStyle = window.getComputedStyle(entry.domNode)
  const verticalPadding =
    Number.parseFloat(wrapperStyle.paddingTop) + Number.parseFloat(wrapperStyle.paddingBottom)
  // Monaco pins the zone’s old height, so scrollHeight cannot detect shrinking; measure the card plus padding.
  const childHeight = child?.getBoundingClientRect().height ?? 0
  // Detached zones cannot be measured; retain the initial estimate until the observer sees the card.
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
