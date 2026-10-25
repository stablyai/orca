import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { searchRuntimeFiles } from '@/runtime/runtime-file-search-client'
import type { OpenFile } from '@/store/slices/editor'
import type { SearchOptions, SearchResult } from '../../../../shared/code-search-types'
import { selectMarkdownDocumentWorktreePath } from './markdown-document-worktree-path-selector'

export type MarkdownWorkspaceSearchState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: T; truncated: boolean }
  | { status: 'error'; message: string }

export type MarkdownWorkspaceSearch<T> = {
  /** Null when there is nothing to search for, e.g. the open note is not in the listing. */
  options: (documents: MarkdownDocument[], rootPath: string) => SearchOptions | null
  interpret: (documents: MarkdownDocument[], result: SearchResult) => T
  empty: T
}

/** Runs one workspace text search over the notes while mounted and interprets the hits with the note list. */
export function useMarkdownWorkspaceSearch<T>(
  activeFile: OpenFile,
  markdownDocuments: MarkdownDocument[],
  /** Keep stable (memoize or hoist); a new object re-runs the search. */
  search: MarkdownWorkspaceSearch<T>
): { state: MarkdownWorkspaceSearchState<T>; refresh: () => void } {
  const worktreeId = activeFile.worktreeId
  const worktreePath = useAppStore((s) => selectMarkdownDocumentWorktreePath(s, worktreeId))
  const connectionId = useAppStore((s) => getConnectionIdFromState(s, worktreeId))
  const [state, setState] = useState<MarkdownWorkspaceSearchState<T>>({ status: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)
  // Why a ref: the listing returns a new array on every watcher refresh, which must not restart the search.
  const documentsRef = useRef(markdownDocuments)
  documentsRef.current = markdownDocuments
  const listed = markdownDocuments.length > 0

  const refresh = useCallback(() => {
    controllerRef.current?.abort()
    const documents = documentsRef.current
    if (documents.length === 0) {
      // Why: the listing has not arrived yet; an empty result would be a guess.
      setState({ status: 'loading' })
      return
    }
    const runtimeTarget = getRuntimeTargetForFileOwner(
      useAppStore.getState(),
      worktreeId,
      activeFile.runtimeEnvironmentId
    )
    const options = worktreePath ? search.options(documents, worktreePath) : null
    // Why: an unknown owner has no workspace to search.
    if (!options || !worktreePath || !runtimeTarget || connectionId === undefined) {
      setState({ status: 'ready', value: search.empty, truncated: false })
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setState({ status: 'loading' })
    searchRuntimeFiles(
      { target: runtimeTarget, worktreeId, worktreePath, connectionId: connectionId ?? undefined },
      options,
      controller.signal
    ).then(
      (result) => {
        if (!controller.signal.aborted) {
          setState({
            status: 'ready',
            value: search.interpret(documents, result),
            truncated: result.truncated
          })
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      }
    )
  }, [activeFile.runtimeEnvironmentId, connectionId, search, worktreeId, worktreePath])

  useEffect(() => {
    refresh()
  }, [refresh, listed])
  useEffect(() => () => controllerRef.current?.abort(), [])

  return { state, refresh }
}
