import type { editor as monacoEditor } from 'monaco-editor'
import type { Root } from 'react-dom/client'
import { readDiffCommentZoneHeight } from './diff-comment-zone-measurement'
import {
  invalidateCombinedEditorGeometry,
  measureCombinedCommentZone
} from '../editor/combined-diff/scroll-viewport/combined-diff-editor-geometry'

export type ZoneEntry = {
  zoneId: string
  domNode: HTMLElement
  // Retain the delegate because Monaco re-reads its mutated heightInPx on layoutZone.
  delegate: monacoEditor.IViewZone
  root: Root
  lifetime: AbortController
  disposeMouseDownStopper: () => void
  lastRenderSignature: string
  // Single-file layout signal; combined reveals wait for intrinsic reservation measurement.
  laidOut: boolean
}

export type DraftZoneEntry = {
  editor: monacoEditor.ICodeEditor
  zoneId: string
  domNode: HTMLElement
  marginDomNode: HTMLElement
  delegate: monacoEditor.IViewZone
  root: Root
  lifetime: AbortController
  draft: { lineNumber: number; startLine?: number }
  body: string
  createComment: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
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
): boolean {
  return measureCombinedCommentZone(editor, entry.zoneId, entry.domNode, () => {
    const measured = readDiffCommentZoneHeight(entry)
    if (measured === null) {
      return false
    }
    if (entry.delegate.heightInPx === measured) {
      return true
    }
    entry.delegate.heightInPx = measured
    editor.changeViewZones((acc) => {
      acc.layoutZone(entry.zoneId)
    })
    invalidateCombinedEditorGeometry(editor)
    return true
  })
}

export type CarriedDiffCommentDraft = Pick<DraftZoneEntry, 'draft' | 'body' | 'createComment'>
export type OpenDiffCommentDraft = (
  draft: DraftZoneEntry['draft'],
  initialBody?: string,
  createComment?: DraftZoneEntry['createComment'],
  focusOnOpen?: boolean
) => boolean

export function snapshotDiffCommentDraft(entry: DraftZoneEntry): CarriedDiffCommentDraft {
  return { draft: entry.draft, body: entry.body, createComment: entry.createComment }
}

export type RestoreDiffCommentDraft = (
  draft: DraftZoneEntry['draft'],
  body: string,
  createComment: DraftZoneEntry['createComment']
) => void

export function disposeDiffCommentDraftZone(entry: DraftZoneEntry, focusEditor: boolean): void {
  entry.lifetime.abort()
  if (entry.editor.getModel()) {
    entry.editor.changeViewZones((accessor) => accessor.removeZone(entry.zoneId))
    invalidateCombinedEditorGeometry(entry.editor)
  }
  entry.disposeMouseDownStopper()
  queueMicrotask(() => entry.root.unmount())
  if (focusEditor) {
    entry.editor.focus()
  }
}
