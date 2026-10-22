import type { OpenFile } from '@/store/slices/editor'
import { scrollTopCache } from '@/lib/scroll-cache'
import {
  disposeUnattachedMonacoModelsByPathPrefixes,
  getDiffViewerMonacoModelPathPrefixes,
  type MonacoModelRegistry,
  type DisposableMonacoModel
} from './diff-monaco-model-disposal'
import { toEditorModelUri } from './editor-model-uri'
import {
  isKeptEditorBufferView,
  type EditorBufferKeptRecords
} from '@/store/slices/editor/buffers/editor-buffer-kept'

export type ClosedEditorTab = Pick<OpenFile, 'id' | 'mode' | 'filePath'> & {
  modelOwnerKey?: string
}

// One registry sweep avoids quadratic close-all work.
export function disposeClosedEditorModels(
  monacoRegistry: MonacoModelRegistry,
  closedFiles: readonly ClosedEditorTab[],
  onAttachedModel?: (model: DisposableMonacoModel, file: ClosedEditorTab) => void,
  isStillClosed: (file: ClosedEditorTab) => boolean = () => true
): void {
  if (closedFiles.length === 0) {
    return
  }

  const diffFilesByPrefix = new Map<string, ClosedEditorTab>()
  for (const closedFile of closedFiles) {
    if (!isStillClosed(closedFile)) {
      continue
    }
    if (closedFile.mode === 'edit') {
      const model = monacoRegistry.editor.getModel(
        monacoRegistry.Uri.parse(toEditorModelUri(closedFile.filePath, closedFile.modelOwnerKey))
      )
      if (model?.isAttachedToEditor()) {
        onAttachedModel?.(model, closedFile)
      } else {
        model?.dispose()
      }
    } else if (closedFile.mode === 'diff') {
      const { originalModelPathPrefix, modifiedModelPathPrefix } =
        getDiffViewerMonacoModelPathPrefixes(closedFile.id)
      diffFilesByPrefix.set(originalModelPathPrefix, closedFile)
      diffFilesByPrefix.set(modifiedModelPathPrefix, closedFile)
    }
  }

  disposeUnattachedMonacoModelsByPathPrefixes(
    monacoRegistry,
    [...diffFilesByPrefix.keys()],
    (model, prefix) => {
      const file = diffFilesByPrefix.get(prefix)
      if (file) {
        onAttachedModel?.(model, file)
      }
    },
    (prefix) => {
      const file = diffFilesByPrefix.get(prefix)
      return file !== undefined && isStillClosed(file)
    }
  )
}
/** Closed edit views whose dirty record is kept, with the model the record owns. */
export function keptClosedEditorTabs<TModel>(
  pending: ReadonlyMap<string, ClosedEditorTab>,
  kept: EditorBufferKeptRecords | undefined,
  modelAt: (uri: string) => TModel | null
): Map<ClosedEditorTab, TModel | null> {
  const result = new Map<ClosedEditorTab, TModel | null>()
  for (const file of pending.values()) {
    if (file.mode === 'edit' && kept && isKeptEditorBufferView(kept, file.id)) {
      result.set(file, modelAt(toEditorModelUri(file.filePath, file.modelOwnerKey)))
    }
  }
  return result
}

export function disposeClosedCheckDetailsReadingCache(
  closedFiles: readonly ClosedEditorTab[],
  isStillClosed: (file: ClosedEditorTab) => boolean = () => true
): void {
  for (const closedFile of closedFiles) {
    if (closedFile.mode !== 'check-details' || !isStillClosed(closedFile)) {
      continue
    }
    for (const key of scrollTopCache.keys()) {
      if (key.startsWith(`${closedFile.id}::`)) {
        scrollTopCache.delete(key)
      }
    }
  }
}
