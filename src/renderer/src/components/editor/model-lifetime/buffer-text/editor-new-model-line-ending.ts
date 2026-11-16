import { useEffect } from 'react'
import type { editor } from 'monaco-editor'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import {
  resolveNewModelLineEnding,
  type EditorLineEnding
} from '../../../../../../shared/editor/saving/editor-end-of-line'
import { resolveEditorFileHostPlatform } from '../identity/editor-file-host-platform'
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
  'getLineCount' | 'getEOL' | 'setEOL' | 'onDidChangeContent' | 'isDisposed'
>

// Why per model: retained models outlive editor mounts and are shared by split panes.
const loadedWithLineBreaks = new WeakMap<LineEndingModel, boolean>()

/** A model is "new" until it holds line breaks the user did not type: loaded or written externally. */
function isNewModel(model: LineEndingModel): boolean {
  let loaded = loadedWithLineBreaks.get(model)
  if (loaded === undefined) {
    loaded = model.getLineCount() > 1
    loadedWithLineBreaks.set(model, loaded)
  }
  return !loaded
}

/** Sets a new model's ending; models loaded with line breaks keep theirs. */
export function applyNewModelLineEnding(
  model: LineEndingModel,
  lineEnding: EditorLineEnding | null,
  modelKey: string
): void {
  if (!lineEnding || !isNewModel(model) || model.getEOL() === lineEnding) {
    return
  }
  // Literal EndOfLineSequence values (LF = 0, CRLF = 1) keep this free of the Monaco runtime.
  const sequence = lineEnding === '\r\n' ? 1 : 0
  if (model.getLineCount() > 1) {
    // Lines typed before the host reported: a real text change the buffer must record.
    model.setEOL(sequence)
    return
  }
  // A one-line switch changes no text; keep its content event from marking the file dirty.
  beginProgrammaticContentSync(modelKey)
  try {
    model.setEOL(sequence)
  } finally {
    endProgrammaticContentSync(modelKey)
  }
}

/** Keeps a new model on its ending through undo, late host reports, and setting changes. */
export function trackNewModelLineEnding(
  model: LineEndingModel,
  lineEnding: EditorLineEnding | null,
  modelKey: string
): { dispose(): void } {
  isNewModel(model)
  applyNewModelLineEnding(model, lineEnding, modelKey)
  let disposed = false
  const subscription = model.onDidChangeContent(() => {
    if (isProgrammaticContentSyncInFlight(modelKey) && model.getLineCount() > 1) {
      // External text with line breaks makes this an existing file; keep the ending it brought.
      loadedWithLineBreaks.set(model, true)
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
  useEffect(() => {
    const model = mountedEditor?.getModel()
    if (!model || model.uri.toString() !== modelUri) {
      return
    }
    const tracker = trackNewModelLineEnding(model, lineEnding, modelUri)
    return () => tracker.dispose()
  }, [mountedEditor, modelUri, lineEnding])
}
