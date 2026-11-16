import { useEffect } from 'react'
import type { editor } from 'monaco-editor'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import {
  resolveNewModelLineEnding,
  type EditorLineEnding
} from '../../../../../../shared/editor/saving/editor-end-of-line'
import { resolveEditorFileHostPlatform } from '../identity/editor-file-host-platform'
import { markForeignLineBreaks, newModelLineEndingState } from './new-model-line-ending-state'
import { getWrittenContentDiskSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync,
  isProgrammaticContentSyncInFlight
} from './monaco-programmatic-sync'

export function resolveOpenFileNewModelLineEnding(
  state: AppState,
  fileId: string,
  language: string
): EditorLineEnding | null {
  const file = state.openFiles?.find((entry) => entry.id === fileId)
  if (!file) {
    return null
  }
  const setting = state.settings?.editorEndOfLine
  return resolveNewModelLineEnding({
    setting,
    // Explicit LF/CRLF needs no host lookup.
    hostPlatform:
      setting === 'lf' || setting === 'crlf' ? null : resolveEditorFileHostPlatform(state, file),
    language
  })
}

type LineEndingModel = Pick<
  editor.ITextModel,
  | 'getLineCount'
  | 'getValue'
  | 'getEOL'
  | 'setEOL'
  | 'pushEOL'
  | 'pushStackElement'
  | 'onDidChangeContent'
  | 'isDisposed'
>

/** Sets a new model's ending; models holding line breaks the user did not type keep theirs. */
export function applyNewModelLineEnding(
  model: LineEndingModel,
  lineEnding: EditorLineEnding | null,
  modelKey: string
): void {
  const state = newModelLineEndingState(model)
  if (!lineEnding || state.foreignLineBreaks) {
    return
  }
  const newChoice = state.applied !== lineEnding
  state.applied = lineEnding
  if (model.getEOL() === lineEnding) {
    return
  }
  // Literal EndOfLineSequence values (LF = 0, CRLF = 1) keep this free of the Monaco runtime.
  const sequence = lineEnding === '\r\n' ? 1 : 0
  if (model.getLineCount() > 1) {
    // Only a new choice (late host report, setting change) converts typed lines; re-converting
    // after Undo would trap Undo on the conversion.
    if (newChoice) {
      // Why an undo step: a bare setEOL leaves undo offsets measured in the old ending.
      model.pushStackElement()
      model.pushEOL(sequence)
      model.pushStackElement()
    }
    return
  }
  // A one-line switch changes no text or offsets; keep its event from marking the file dirty.
  beginProgrammaticContentSync(modelKey)
  try {
    model.setEOL(sequence)
  } finally {
    endProgrammaticContentSync(modelKey)
  }
}

// Why bytes, not the dirty flag: Markdown dirty state ignores trailing whitespace such as a new line.
function isSavedWithLineBreaks(model: LineEndingModel, diskSignature: string): boolean {
  return (
    model.getLineCount() > 1 &&
    !newModelLineEndingState(model).foreignLineBreaks &&
    getWrittenContentDiskSignature(model.getValue()) === diskSignature
  )
}

/** Keeps a new model on its ending through undo, late host reports, and setting changes. */
export function trackNewModelLineEnding(
  model: LineEndingModel,
  lineEnding: EditorLineEnding | null,
  modelKey: string,
  /** Signature of the bytes last known on disk; saved line breaks are never converted. */
  diskSignature?: string
): { dispose(): void } {
  if (diskSignature && isSavedWithLineBreaks(model, diskSignature)) {
    markForeignLineBreaks(model)
  }
  applyNewModelLineEnding(model, lineEnding, modelKey)
  let disposed = false
  const subscription = model.onDidChangeContent(() => {
    if (isProgrammaticContentSyncInFlight(modelKey) && model.getLineCount() > 1) {
      markForeignLineBreaks(model)
      return
    }
    // Why deferred: re-entrant edits would reach later listeners out of order (undo restores old EOLs).
    queueMicrotask(() => {
      if (!disposed && !model.isDisposed()) {
        applyNewModelLineEnding(model, lineEnding, modelKey)
      }
    })
  })
  return {
    dispose() {
      disposed = true
      subscription.dispose()
    }
  }
}

export function useNewModelLineEnding(
  mountedEditor: editor.IStandaloneCodeEditor | null,
  modelUri: string,
  fileId: string,
  language: string
): void {
  const lineEnding = useAppStore((state) =>
    resolveOpenFileNewModelLineEnding(state, fileId, language)
  )
  const diskSignature = useAppStore(
    (state) => state.openFiles?.find((entry) => entry.id === fileId)?.lastKnownDiskSignature
  )
  useEffect(() => {
    const model = mountedEditor?.getModel()
    if (!model || model.uri.toString() !== modelUri) {
      return
    }
    const tracker = trackNewModelLineEnding(model, lineEnding, modelUri, diskSignature)
    return () => tracker.dispose()
  }, [mountedEditor, modelUri, lineEnding, diskSignature])
}
