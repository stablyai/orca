import type { OpenFile } from '@/store/slices/editor'
import {
  editorSelectionCache,
  diffViewStateCache,
  pdfViewPositionCache,
  scrollTopCache
} from '@/lib/scroll-cache'
import {
  disposeUnattachedMonacoModelsByPathPrefixes,
  getDiffViewerMonacoModelPathPrefixes,
  type MonacoModelRegistry
} from './diff-monaco-model-disposal'
import {
  deletePaneScopedCacheEntries,
  sweepClosedPdfViewPositions
} from './closed-editor-tab-cache-sweep'
import {
  recordUnparseableModelPathShape,
  toMonacoEditModelPath,
  type MonacoUriNamespace
} from './monaco-edit-model-path'

export type ClosedEditorTabMonacoRegistry = Omit<MonacoModelRegistry, 'Uri'> & {
  Uri: MonacoUriNamespace
}

function disposeEditTabModel(
  monacoRegistry: ClosedEditorTabMonacoRegistry,
  filePath: string
): void {
  let modelUri: unknown
  try {
    modelUri = monacoRegistry.Uri.parse(toMonacoEditModelPath(monacoRegistry.Uri, filePath))
  } catch {
    // Reached only if Uri.file() itself rejects the path: no key exists, so nothing to dispose.
    recordUnparseableModelPathShape('editor_model_dispose_path_unkeyable', filePath)
    return
  }
  monacoRegistry.editor.getModel(modelUri)?.dispose()
}

/**
 * Releases the Monaco models and view-state cache entries owned by a batch of closed tabs.
 *
 * Why the batch shape: every prefix sweep here is a full scan of a shared registry or cache, so
 * doing one per closed tab makes "close all"/worktree-switch quadratic in retained models. Takes
 * the monaco namespace as an argument so it stays testable without importing `monaco-editor`.
 */
export function disposeClosedEditorTabs(
  monacoRegistry: ClosedEditorTabMonacoRegistry,
  closedFiles: readonly OpenFile[]
): void {
  if (closedFiles.length === 0) {
    return
  }

  const diffModelPathPrefixes: string[] = []
  const scrollTopOwners: string[] = []
  const editorSelectionOwners: string[] = []
  const diffViewStateOwners: string[] = []
  const closedPdfFilePaths: string[] = []

  for (const closedFile of closedFiles) {
    switch (closedFile.mode) {
      case 'edit':
        // Why: the edit model URI is keyed by the same path @monaco-editor/react
        // hands Monaco, so create and dispose stay on one key.
        disposeEditTabModel(monacoRegistry, closedFile.filePath)
        scrollTopCache.delete(closedFile.filePath)
        // Why: markdown and mermaid surfaces keep mode-scoped scroll positions.
        scrollTopCache.delete(`${closedFile.filePath}:rich`)
        scrollTopCache.delete(`${closedFile.filePath}:preview`)
        scrollTopCache.delete(`${closedFile.filePath}:mermaid-diagram`)
        editorSelectionCache.delete(closedFile.filePath)
        scrollTopOwners.push(closedFile.filePath)
        editorSelectionOwners.push(closedFile.filePath)
        // Why: only 'edit' tabs ever get a PDF scroll key (see EditorContent).
        closedPdfFilePaths.push(closedFile.filePath)
        break
      case 'markdown-preview':
        // Why: preview tabs own pane-scoped preview scroll cache entries even
        // though they do not retain Monaco models.
        scrollTopCache.delete(`${closedFile.id}:preview`)
        scrollTopOwners.push(closedFile.id)
        break
      case 'diff': {
        // Why: kept diff models are keyed by tab id, and fallback recovery can
        // append generation suffixes; closing the tab owns that whole namespace.
        const { originalModelPathPrefix, modifiedModelPathPrefix } =
          getDiffViewerMonacoModelPathPrefixes(closedFile.id)
        diffModelPathPrefixes.push(originalModelPathPrefix, modifiedModelPathPrefix)
        diffViewStateCache.delete(closedFile.id)
        diffViewStateOwners.push(closedFile.id)
        scrollTopCache.delete(`${closedFile.id}:preview`)
        scrollTopOwners.push(closedFile.id)
        break
      }
      case 'conflict-review':
        break
      case 'check-details':
        break
    }
  }

  disposeUnattachedMonacoModelsByPathPrefixes(monacoRegistry, diffModelPathPrefixes)
  deletePaneScopedCacheEntries(scrollTopCache, scrollTopOwners)
  deletePaneScopedCacheEntries(editorSelectionCache, editorSelectionOwners)
  deletePaneScopedCacheEntries(diffViewStateCache, diffViewStateOwners)
  sweepClosedPdfViewPositions(pdfViewPositionCache, closedPdfFilePaths)
}
