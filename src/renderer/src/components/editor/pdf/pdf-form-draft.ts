import type * as pdfjsLib from 'pdfjs-dist'
import type { CustomEditorBinaryDocument } from '../plugin-editors/plugin-custom-editor-host-types'
import {
  editorBytesEditingView,
  holdEditorBytesEdits,
  loadEditorBytes,
  releaseEditorBytesEdits,
  setEditorBytesDraft,
  sha256Hex
} from '../save/bytes/editor-bytes-documents'
import { registerEditorFrameFlush } from '../save/flush/editor-pending-flush'
import { captureViewEditGeneration } from '../save/flush/editor-stale-view-edit'
import type { EditorDiscardGeneration } from '../save/flush/editor-discard-epoch'

// pdf.js commits text and choices on input, checkboxes and radios on change, Reset on click.
const USER_FORM_INPUT_EVENTS = ['input', 'change', 'click'] as const

/**
 * Hands a PDF's filled-in form fields to the tab's save pipeline. An edit only marks the tab
 * dirty; pdf.js serializes the file when a save, close or view switch flushes it.
 */
export function attachPdfFormDraft({
  doc,
  root,
  fileId,
  view,
  baseline,
  onDraft
}: {
  doc: pdfjsLib.PDFDocumentProxy
  /** Holds the form fields; their input events tell user edits from pdf.js's own writes. */
  root: HTMLElement
  fileId: string
  /** This mounted viewer; while it holds unserialized edits, other views of the file are read-only. */
  view: symbol
  /** The bytes this document was loaded from when they already back the tab's bytes document. */
  baseline: 'tracked' | { editsAtLoad: number | undefined }
  onDraft: (draft: CustomEditorBinaryDocument) => void
}): { detach: () => Promise<void> } {
  const storage = doc.annotationStorage
  let baselineRecorded: Promise<void> | null = baseline === 'tracked' ? Promise.resolve() : null
  let unserialized: EditorDiscardGeneration | null = null
  let held = false
  let detached = false
  let userInput = false
  const noteUserInput = (): void => {
    userInput = true
    setTimeout(() => {
      userInput = false
    })
  }
  for (const type of USER_FORM_INPUT_EVENTS) {
    root.addEventListener(type, noteUserInput, true)
  }

  const recordBaseline = (): Promise<void> => {
    baselineRecorded ??= (async () => {
      const bytes = new Uint8Array(await doc.getData())
      const sha256 = await sha256Hex(bytes)
      if (baseline !== 'tracked') {
        loadEditorBytes(fileId, { bytes, fileType: 'pdf' }, sha256, baseline.editsAtLoad)
      }
    })()
    return baselineRecorded
  }

  // Why the hold drops: Reload or Don't Save cleaned the tab, so these edits are no longer wanted.
  const discarded = (): boolean =>
    unserialized?.discarded === true || (held && editorBytesEditingView(fileId) !== view)

  const settle = (): void => {
    unserialized = null
    if (held) {
      held = false
      releaseEditorBytesEdits(fileId, view)
    }
  }

  Object.assign(storage, {
    onSetModified: () => {
      if (detached) {
        return
      }
      // Why: rendering a radio group writes its siblings' values; that is not an edit.
      if (!userInput) {
        storage.resetModified()
        return
      }
      unserialized ??= captureViewEditGeneration(fileId)
      held ||= holdEditorBytesEdits(fileId, view)
    }
  })

  let flushing: Promise<boolean> = Promise.resolve(true)
  const serialize = async (): Promise<boolean> => {
    if (!unserialized || !held) {
      return true
    }
    await recordBaseline()
    let before: string
    do {
      before = storage.serializable.hash
      const draft = { bytes: await doc.saveDocument(), fileType: 'pdf' }
      if (discarded()) {
        break
      }
      onDraft(draft)
      setEditorBytesDraft(fileId, draft)
      // Why: an edit made while pdf.js serialized is not in those bytes, so serialize again.
    } while (storage.serializable.hash !== before)
    settle()
    return true
  }
  const flush = (): Promise<boolean> => {
    flushing = flushing.then(serialize, serialize)
    return flushing
  }
  const unregisterFlush = registerEditorFrameFlush(fileId, flush)

  return {
    detach: async () => {
      detached = true
      for (const type of USER_FORM_INPUT_EVENTS) {
        root.removeEventListener(type, noteUserInput, true)
      }
      // Why: a save or close while this view serializes must still wait for it.
      try {
        await flush()
      } finally {
        unregisterFlush()
      }
    }
  }
}
