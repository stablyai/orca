import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type * as pdfjsLib from 'pdfjs-dist'
import { useAppStore } from '@/store/index'
import type { PdfDocumentLoader, PdfDocumentSource } from './pdf-document-loader'
import { attachPdfFormDraft } from './pdf-form-draft'
import {
  editorBytesDocument,
  editorBytesEdits,
  editorBytesEditingView,
  hasEditorBytesDraft,
  releaseEditorBytes,
  retainEditorBytes,
  subscribeEditorBytes
} from '../save/bytes/editor-bytes-documents'
import type { CustomEditorBinaryDocument } from '../plugin-editors/plugin-custom-editor-host-types'
import { editorShortcutMatches } from '../commands/editor-shortcuts'
import {
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestCmdSaveDetail
} from '../autosave/editor-autosave'

/** What a viewer shows: the tab's bytes document it was loaded from (null: the disk copy). */
type PdfShown = { document: CustomEditorBinaryDocument | null; editable: boolean }

/**
 * Lets a writable tab's PDF viewer fill in form fields that save through the tab. Split panes
 * share one draft: a pane reloads when another pane changes it, and stays read-only while
 * another pane holds edits it has not serialized yet.
 */
export function usePdfFormEditing(
  editFileId: string | null,
  rootRef: RefObject<HTMLDivElement | null>,
  loaderRef: RefObject<PdfDocumentLoader | null>
): {
  attach: (doc: pdfjsLib.PDFDocumentProxy) => { detach: () => Promise<void> } | null
  load: (diskSource: PdfDocumentSource) => void
  reset: () => void
} {
  const [view] = useState(() => Symbol('pdf-form-view'))
  const shownRef = useRef<PdfShown | null>(null)
  const diskSourceRef = useRef<PdfDocumentSource | null>(null)

  useEffect(() => {
    if (!editFileId) {
      return
    }
    retainEditorBytes(editFileId)
    return () => releaseEditorBytes(editFileId)
  }, [editFileId])

  useEffect(() => {
    const root = rootRef.current
    if (!editFileId || !root) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Why: the workspace save fallback skips focused inputs, here form fields, and handles the rest.
      if (event.defaultPrevented || event.repeat || !editorShortcutMatches('editor.save', event)) {
        return
      }
      event.preventDefault()
      window.dispatchEvent(
        new CustomEvent<EditorRequestCmdSaveDetail>(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, {
          detail: { fileId: editFileId }
        })
      )
    }
    root.addEventListener('keydown', handleKeyDown, true)
    return () => root.removeEventListener('keydown', handleKeyDown, true)
  }, [editFileId, rootRef])

  const show = useCallback(
    (document: CustomEditorBinaryDocument | null) => {
      const source = document ? { bytes: document.bytes } : diskSourceRef.current
      if (!source) {
        return
      }
      const holder = editFileId ? editorBytesEditingView(editFileId) : null
      shownRef.current = { document, editable: editFileId !== null && holder === null }
      loaderRef.current?.load(source)
    },
    [editFileId, loaderRef]
  )

  useEffect(() => {
    if (!editFileId) {
      return
    }
    return subscribeEditorBytes(() => {
      const shown = shownRef.current
      const holder = editorBytesEditingView(editFileId)
      if (!shown || holder === view) {
        return
      }
      const document = editorBytesDocument(editFileId)
      if (document !== shown.document || shown.editable !== (holder === null)) {
        show(document)
      }
    })
  }, [editFileId, show, view])

  const attach = useCallback(
    (doc: pdfjsLib.PDFDocumentProxy) => {
      const shown = shownRef.current
      const root = rootRef.current
      if (!editFileId || !shown?.editable || !root) {
        return null
      }
      return attachPdfFormDraft({
        doc,
        root,
        fileId: editFileId,
        view,
        baseline: shown.document ? 'tracked' : { editsAtLoad: editorBytesEdits(editFileId) },
        onDraft: (draft) => {
          shownRef.current = { document: draft, editable: true }
        }
      })
    },
    [editFileId, rootRef, view]
  )

  const load = useCallback(
    (diskSource: PdfDocumentSource) => {
      diskSourceRef.current = diskSource
      if (!editFileId) {
        show(null)
        return
      }
      // Why: a dirty tab's live form edits outrank a disk reload; Reload cleans the tab first.
      const dirty = useAppStore.getState().openFiles.find((file) => file.id === editFileId)?.isDirty
      if (shownRef.current && dirty) {
        return
      }
      show(hasEditorBytesDraft(editFileId) ? editorBytesDocument(editFileId) : null)
    },
    [editFileId, show]
  )

  const reset = useCallback(() => {
    shownRef.current = null
  }, [])

  return { attach, load, reset }
}
