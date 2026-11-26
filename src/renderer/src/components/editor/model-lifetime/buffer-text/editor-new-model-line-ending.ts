import { useEffect } from 'react'
import type { editor } from 'monaco-editor'
import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import {
  resolveNewModelLineEnding,
  type EditorLineEnding
} from '../../../../../../shared/editor/saving/editor-end-of-line'
import { resolveEditorFileHostPlatform } from '../identity/editor-file-host-platform'
import { isExistingFileModel, markExistingFileModel } from './existing-file-line-ending'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync,
  isProgrammaticContentSyncInFlight
} from './monaco-programmatic-sync'

export function resolveOpenFileNewModelLineEnding(
  state: AppState,
  statuses: RuntimeStatuses,
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
      setting === 'lf' || setting === 'crlf'
        ? null
        : resolveEditorFileHostPlatform(state, statuses, file),
    language
  })
}

type LineEndingModel = Pick<
  editor.ITextModel,
  'getLineCount' | 'getEOL' | 'setEOL' | 'onDidChangeContent' | 'isDisposed'
>

/**
 * Sets the ending of a model that has at most one line. A model with line breaks is never
 * converted: its text and undo history already carry its ending.
 */
export function applyNewModelLineEnding(
  model: LineEndingModel,
  lineEnding: EditorLineEnding | null,
  modelKey: string
): void {
  if (
    !lineEnding ||
    isExistingFileModel(model) ||
    model.getLineCount() > 1 ||
    model.getEOL() === lineEnding
  ) {
    return
  }
  // A one-line switch changes no text or undo offsets; keep its event from marking the file dirty.
  beginProgrammaticContentSync(modelKey)
  try {
    // Literal EndOfLineSequence values (LF = 0, CRLF = 1) keep this free of the Monaco runtime.
    model.setEOL(lineEnding === '\r\n' ? 1 : 0)
  } finally {
    endProgrammaticContentSync(modelKey)
  }
}

/** Applies the ending now and again whenever an edit (such as Undo) leaves one line. */
export function trackNewModelLineEnding(
  model: LineEndingModel,
  lineEnding: EditorLineEnding | null,
  modelKey: string
): { dispose(): void } {
  // Mount-time breaks came from disk or an outside write; emptying the file must not switch them.
  if (model.getLineCount() > 1) {
    markExistingFileModel(model)
  }
  applyNewModelLineEnding(model, lineEnding, modelKey)
  let disposed = false
  const subscription = model.onDidChangeContent(() => {
    if (isProgrammaticContentSyncInFlight(modelKey) && model.getLineCount() > 1) {
      markExistingFileModel(model)
      return
    }
    // Why deferred: re-entrant edits would reach later listeners out of order.
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
  const lineEnding = useAppStoreWithHostStatuses((state, statuses) =>
    resolveOpenFileNewModelLineEnding(state, statuses, fileId, language)
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
