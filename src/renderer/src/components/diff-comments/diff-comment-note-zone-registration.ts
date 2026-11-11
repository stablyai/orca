import type { editor as monacoEditor } from 'monaco-editor'
import {
  isCombinedEditorBindingCurrent,
  registerCombinedCommentZone
} from '../editor/combined-diff/scroll-viewport/combined-diff-editor-geometry'
import type { ZoneEntry } from './diff-comment-view-zone-entry'
import { untilDiffCommentZoneRemoved } from './diff-comment-zone-lifetime'
import { registerDiffCommentZoneMeasurement } from './diff-comment-zone-measurement'

export function registerDiffCommentNoteZone(
  editor: monacoEditor.ICodeEditor,
  identity: string | undefined,
  zones: Map<string, ZoneEntry>,
  commentId: string,
  entry: ZoneEntry,
  measured: () => void
): void {
  const { zoneId, domNode: dom, lifetime } = entry
  const current = (): boolean =>
    zones.get(commentId) === entry &&
    !lifetime.signal.aborted &&
    isCombinedEditorBindingCurrent(editor, identity)
  untilDiffCommentZoneRemoved(
    lifetime.signal,
    registerCombinedCommentZone(editor, zoneId, dom, () => {
      if (!current()) {
        return []
      }
      const card = dom.firstElementChild
      return card instanceof HTMLElement && card.isConnected ? [card] : []
    })
  )
  if (!isCombinedEditorBindingCurrent(editor)) {
    registerDiffCommentZoneMeasurement(editor, entry, lifetime.signal, current, measured)
  }
}
