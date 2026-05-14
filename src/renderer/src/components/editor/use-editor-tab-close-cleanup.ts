import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { scrollTopCache, cursorPositionCache, diffViewStateCache } from '@/lib/scroll-cache'
import { findLeakedDiffModelPaths } from './editor-model-leak'

// Why: keepCurrentModel / keepCurrent*Model retain Monaco models after unmount
// so undo history survives tab switches. When a tab is *closed*, the user has
// signalled they're done with the file — dispose the models to reclaim memory
// and delete cache entries so a reopened file starts fresh.
//
// Why this lives at the App level rather than inside EditorPanel: EditorPanel
// is conditionally mounted on the active tab, so when the active tab is
// closed the panel unmounts before its own cleanup effect can run, leaking
// the kept models. An always-mounted hook observes `openFiles` from the
// store directly and disposes models for any tab that has disappeared,
// regardless of which tab was active.

function deleteCacheEntriesByPrefix<T>(cache: Map<string, T>, prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}

export function useEditorTabCloseCleanup(): void {
  const openFiles = useAppStore((s) => s.openFiles)
  const prevOpenFilesRef = useRef<Map<string, OpenFile>>(new Map())

  useEffect(() => {
    const currentFilesById = new Map(openFiles.map((f) => [f.id, f]))
    for (const [prevId, prevFile] of prevOpenFilesRef.current) {
      if (currentFilesById.has(prevId)) {
        continue
      }
      // Dispose only the kept-alive Monaco state that this tab mode owns.
      // Why: edit and diff tabs use different retained-model keys, while the
      // conflict-review surface does not create kept Monaco models today. An
      // explicit switch makes that ownership boundary visible so future mode
      // additions do not silently fall through without considering cleanup.
      switch (prevFile.mode) {
        case 'edit': {
          // Why: the edit model URI is constructed via monaco.Uri.parse(filePath)
          // to match what @monaco-editor/react creates internally when the `path`
          // prop is provided. This convention is version-dependent.
          monaco.editor.getModel(monaco.Uri.parse(prevFile.filePath))?.dispose()
          // Why: edit-mode tabs that ever entered Changes view mode mounted a
          // DiffViewer with `keepCurrent*Model`, which leaves both diff models
          // in `monaco.editor.getModels()` after this tab closes. Disposing
          // the plain edit model above does not touch them. Iterate the model
          // registry and dispose any that match this tab's id (covers both
          // single-pane and split-pane URI shapes plus the rotated-original
          // hash). `closeFile` clears `editorViewMode[fileId]` synchronously
          // so we cannot gate on it; doing the prefix scan unconditionally
          // is a no-op for tabs that never entered Changes mode.
          const allModels = monaco.editor.getModels()
          const leakedPaths = new Set(
            findLeakedDiffModelPaths(
              allModels.map((m) => m.uri),
              prevId,
              'changes'
            )
          )
          for (const model of allModels) {
            if (model.uri.scheme === 'diff' && leakedPaths.has(model.uri.path)) {
              model.dispose()
            }
          }
          diffViewStateCache.delete(prevId)
          deleteCacheEntriesByPrefix(diffViewStateCache, `${prevId}::`)
          scrollTopCache.delete(prevFile.filePath)
          deleteCacheEntriesByPrefix(scrollTopCache, `${prevFile.filePath}::`)
          // Why: markdown edit tabs keep separate source/rich scroll caches,
          // and older sessions may still have the legacy in-place preview key.
          // Clear all of them so reopened files never inherit stale viewport
          // state from a prior tab incarnation.
          scrollTopCache.delete(`${prevFile.filePath}:rich`)
          scrollTopCache.delete(`${prevFile.filePath}:preview`)
          // Why: mermaid files use a mode-scoped cache key just like markdown.
          // Without this, a reopened .mmd file would restore a stale scroll
          // position from the previous session even if the content changed.
          scrollTopCache.delete(`${prevFile.filePath}:mermaid-diagram`)
          cursorPositionCache.delete(prevFile.filePath)
          deleteCacheEntriesByPrefix(cursorPositionCache, `${prevFile.filePath}::`)
          break
        }
        case 'markdown-preview':
          // Why: preview tabs have no retained Monaco models, but they do
          // own pane-scoped preview scroll cache entries that should be
          // dropped on close so reopening the preview starts fresh.
          scrollTopCache.delete(`${prevFile.id}:preview`)
          deleteCacheEntriesByPrefix(scrollTopCache, `${prevFile.id}::`)
          break
        case 'diff': {
          // Why: kept diff models are keyed by tab id, not file path, because the
          // same file can appear in multiple diff tabs with different contents.
          // Split-pane layouts append `::${viewStateScopeId}` to the URI, so a
          // prefix scan over the model registry catches the secondary-pane
          // models that an exact-URI lookup would miss.
          const allModels = monaco.editor.getModels()
          const leakedPaths = new Set(
            findLeakedDiffModelPaths(
              allModels.map((m) => m.uri),
              prevId,
              'diff'
            )
          )
          for (const model of allModels) {
            if (model.uri.scheme === 'diff' && leakedPaths.has(model.uri.path)) {
              model.dispose()
            }
          }
          diffViewStateCache.delete(prevId)
          deleteCacheEntriesByPrefix(diffViewStateCache, `${prevId}::`)
          // Why: single-file markdown diffs now have a rendered preview mode
          // whose scroll position is keyed off the diff tab identity rather
          // than a Monaco view-state cache entry. Clear those mode-scoped
          // keys alongside the diff models so reopened diff tabs start fresh.
          scrollTopCache.delete(`${prevId}:preview`)
          deleteCacheEntriesByPrefix(scrollTopCache, `${prevId}::`)
          break
        }
        case 'conflict-review':
          break
      }
    }
    prevOpenFilesRef.current = currentFilesById
  }, [openFiles])
}
