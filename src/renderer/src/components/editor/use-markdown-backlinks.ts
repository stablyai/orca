import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { searchRuntimeFiles } from '@/runtime/runtime-file-search-client'
import type { OpenFile } from '@/store/slices/editor'
import {
  collectMarkdownBacklinks,
  markdownBacklinkSearchOptions,
  type MarkdownBacklink
} from './markdown-backlinks'
import { selectMarkdownDocumentWorktreePath } from './markdown-document-worktree-path-selector'

export type MarkdownBacklinksState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; backlinks: MarkdownBacklink[]; truncated: boolean }
  | { status: 'error'; message: string }

/** Finds notes linking to `activeFile` while mounted: one workspace text search, then link resolution. */
export function useMarkdownBacklinks(
  activeFile: OpenFile,
  markdownDocuments: MarkdownDocument[]
): { state: MarkdownBacklinksState; refresh: () => void } {
  const worktreeId = activeFile.worktreeId
  const worktreePath = useAppStore((s) => selectMarkdownDocumentWorktreePath(s, worktreeId))
  const connectionId = useAppStore((s) => getConnectionIdFromState(s, worktreeId))
  const [state, setState] = useState<MarkdownBacklinksState>({ status: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)
  // Why a ref: the listing returns a new array on every watcher refresh, which must not restart the search.
  const documentsRef = useRef(markdownDocuments)
  documentsRef.current = markdownDocuments
  const listed = markdownDocuments.length > 0

  const refresh = useCallback(() => {
    controllerRef.current?.abort()
    const documents = documentsRef.current
    if (documents.length === 0) {
      // Why: the listing has not arrived yet; "no backlinks" would be a guess.
      setState({ status: 'loading' })
      return
    }
    const target = documents.find((document) => document.filePath === activeFile.filePath)
    const runtimeTarget = getRuntimeTargetForFileOwner(
      useAppStore.getState(),
      worktreeId,
      activeFile.runtimeEnvironmentId
    )
    // Why: an unknown owner or a note outside the listed documents has no workspace to search.
    if (!target || !worktreePath || !runtimeTarget || connectionId === undefined) {
      setState({ status: 'ready', backlinks: [], truncated: false })
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setState({ status: 'loading' })
    searchRuntimeFiles(
      { target: runtimeTarget, worktreeId, worktreePath, connectionId: connectionId ?? undefined },
      markdownBacklinkSearchOptions(target, worktreePath),
      controller.signal
    ).then(
      (result) => {
        if (!controller.signal.aborted) {
          setState({
            status: 'ready',
            backlinks: collectMarkdownBacklinks(target, documents, result),
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
  }, [activeFile.filePath, activeFile.runtimeEnvironmentId, connectionId, worktreeId, worktreePath])

  useEffect(() => {
    refresh()
  }, [refresh, listed])
  useEffect(() => () => controllerRef.current?.abort(), [])

  return { state, refresh }
}
