import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import type { OpenFile } from '@/store/slices/editor'
import { cursorPositionCache, diffViewStateCache, scrollTopCache } from '@/lib/scroll-cache'

function deleteCacheEntriesByPrefix<T>(cache: Map<string, T>, prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}

export function useClosedEditorTabCleanup(openFiles: OpenFile[]): void {
  const prevOpenFilesRef = useRef<Map<string, OpenFile>>(new Map())

  useEffect(() => {
    const currentFilesById = new Map(openFiles.map((f) => [f.id, f]))
    for (const [prevId, prevFile] of prevOpenFilesRef.current) {
      if (!currentFilesById.has(prevId)) {
        disposeClosedEditorTab(prevId, prevFile)
      }
    }
    prevOpenFilesRef.current = currentFilesById
  }, [openFiles])
}

function disposeClosedEditorTab(prevId: string, prevFile: OpenFile): void {
  switch (prevFile.mode) {
    case 'edit':
      // Why: the edit model URI is constructed via monaco.Uri.parse(filePath)
      // to match @monaco-editor/react's `path` prop convention.
      monaco.editor.getModel(monaco.Uri.parse(prevFile.filePath))?.dispose()
      scrollTopCache.delete(prevFile.filePath)
      deleteCacheEntriesByPrefix(scrollTopCache, `${prevFile.filePath}::`)
      // Why: markdown and mermaid surfaces keep mode-scoped scroll positions.
      scrollTopCache.delete(`${prevFile.filePath}:rich`)
      scrollTopCache.delete(`${prevFile.filePath}:preview`)
      scrollTopCache.delete(`${prevFile.filePath}:mermaid-diagram`)
      cursorPositionCache.delete(prevFile.filePath)
      deleteCacheEntriesByPrefix(cursorPositionCache, `${prevFile.filePath}::`)
      break
    case 'markdown-preview':
      // Why: preview tabs own pane-scoped preview scroll cache entries even
      // though they do not retain Monaco models.
      scrollTopCache.delete(`${prevFile.id}:preview`)
      deleteCacheEntriesByPrefix(scrollTopCache, `${prevFile.id}::`)
      break
    case 'diff':
      // Why: kept diff models are keyed by tab id because one file can appear
      // in multiple diff tabs with different contents.
      monaco.editor.getModel(monaco.Uri.parse(`diff:original:${prevId}`))?.dispose()
      monaco.editor.getModel(monaco.Uri.parse(`diff:modified:${prevId}`))?.dispose()
      diffViewStateCache.delete(prevId)
      deleteCacheEntriesByPrefix(diffViewStateCache, `${prevId}::`)
      scrollTopCache.delete(`${prevId}:preview`)
      deleteCacheEntriesByPrefix(scrollTopCache, `${prevId}::`)
      break
    case 'conflict-review':
      break
  }
}
