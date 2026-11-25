import { toast } from 'sonner'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import '@/lib/workspace/ownership/connection-context'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { statRuntimePath } from '@/runtime/files/metadata/runtime-file-metadata-client'
import { acquireEditorFileOperation } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { getRuntimeTargetForFileOwner } from '@/lib/files/access/file-owner-runtime-target'
import { relativePathInsideRoot } from '../../../../../../shared/file-access/cross-platform-path'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor/types/open-file'
import {
  getMarkdownDocumentIndex,
  getMarkdownDocLinkAnchor,
  resolveMarkdownDocLink
} from './markdown-doc-links'
import { selectMarkdownDocumentWorktreePath } from './markdown-document-worktree-path-selector'
import { requestSharedMarkdownDocumentList } from './markdown-document-list-request'
import { findRestoredEditorWorkspaceRuntimeOwner } from '../../file-ownership/restored-editor-workspace-runtime-owner'
import {
  getLatestMarkdownMembershipChangeAt,
  useMarkdownDocumentWatchRefresh
} from './use-markdown-document-watch-refresh'

type OpenMarkdownDocumentOptions = {
  anchor?: string | null
}

export async function saveMarkdownAndRefreshDocuments(
  content: string,
  save: (content: string) => Promise<boolean>,
  refresh: () => Promise<void>
): Promise<boolean> {
  const didSave = await save(content)
  if (!didSave) {
    return false
  }
  await refresh()
  return true
}

type UseMarkdownDocumentsResult = {
  markdownDocuments: MarkdownDocument[]
  openMarkdownDocument: (
    document: MarkdownDocument,
    options?: OpenMarkdownDocumentOptions
  ) => Promise<void>
  onOpenDocLink: (target: string) => void
  previewProps: {
    markdownDocuments: MarkdownDocument[]
    onOpenDocument: (
      document: MarkdownDocument,
      options?: OpenMarkdownDocumentOptions
    ) => Promise<void>
  }
  mdSave: (content: string) => Promise<boolean>
}

export function useMarkdownDocuments(
  activeFile: OpenFile,
  isMarkdown: boolean,
  viewMode: MarkdownViewMode,
  onSave: (content: string) => Promise<boolean>
): UseMarkdownDocumentsResult {
  const worktreeId = activeFile.worktreeId
  // PTY metadata churn must not wake every document-link controller unless the routing path changed.
  const worktreePath = useAppStore((s) => selectMarkdownDocumentWorktreePath(s, worktreeId))
  const openFile = useAppStore((s) => s.openFile)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const connectionId = useAppStore((state) => getConnectionIdFromState(state, worktreeId))
  const scopeKey = JSON.stringify([
    activeFile.runtimeEnvironmentId,
    connectionId,
    worktreeId,
    worktreePath
  ])
  const [snapshot, setSnapshot] = useState<{ key: string; documents: MarkdownDocument[] } | null>(
    null
  )
  const requestRef = useRef(0)
  // Only the latest listing, once settled, proves membership: an in-flight one may predate a delete.
  const settledListingRef = useRef<{ requestId: number; relativePaths: Set<string> } | null>(null)

  const isListed = useCallback((relativePath: string): boolean => {
    const listing = settledListingRef.current
    return listing?.requestId === requestRef.current && listing.relativePaths.has(relativePath)
  }, [])

  const refreshMarkdownDocuments = useCallback(
    async (
      requireFresh = false,
      freshAfter?: number,
      background = freshAfter !== undefined
    ): Promise<void> => {
      if (!worktreeId || !worktreePath) {
        return
      }
      const state = useAppStore.getState()
      const target = getRuntimeTargetForFileOwner(
        state,
        worktreeId,
        activeFile.runtimeEnvironmentId
      )
      // The content loader reowns retained tabs before metadata may use their new host.
      if (
        !target ||
        findRestoredEditorWorkspaceRuntimeOwner(
          state,
          {
            worktreeId,
            filePath: activeFile.filePath,
            externalSshTargetId: activeFile.externalSshTargetId,
            operationProvenance: activeFile.operationProvenance,
            runtimeEnvironmentId: activeFile.runtimeEnvironmentId
          },
          worktreeId
        ) ||
        (connectionId === undefined && target.kind === 'local')
      ) {
        return
      }

      const requestId = requestRef.current + 1
      requestRef.current = requestId
      try {
        const documents = await requestSharedMarkdownDocumentList(
          {
            target,
            worktreeId,
            worktreePath,
            connectionId: connectionId ?? undefined
          },
          worktreePath,
          { requireFresh, ...(freshAfter === undefined ? {} : { freshAfter }) }
        )
        if (requestRef.current !== requestId) {
          return
        }
        settledListingRef.current = {
          requestId,
          relativePaths: new Set(documents.map((document) => document.relativePath))
        }
        setSnapshot({ key: scopeKey, documents })
      } catch (err) {
        console.error('Failed to list markdown documents:', err)
        // Watcher refreshes are background work: keep the last good list and stay quiet.
        if (background) {
          return
        }
        if (requestRef.current === requestId) {
          toast.error(
            err instanceof Error
              ? err.message
              : translate(
                  'auto.components.editor.useMarkdownDocuments.listFailed',
                  'Failed to list Markdown documents.'
                )
          )
        }
        if (requestRef.current === requestId) {
          setSnapshot({ key: scopeKey, documents: [] })
        }
      }
    },
    [
      activeFile.filePath,
      activeFile.externalSshTargetId,
      activeFile.operationProvenance,
      activeFile.runtimeEnvironmentId,
      connectionId,
      worktreeId,
      worktreePath,
      scopeKey
    ]
  )

  const openMarkdownDocument = useCallback(
    async (
      document: MarkdownDocument,
      options: OpenMarkdownDocumentOptions = {}
    ): Promise<void> => {
      if (!worktreeId || !worktreePath) {
        return
      }
      let acquisition: ReturnType<typeof acquireEditorFileOperation>
      try {
        acquisition = acquireEditorFileOperation(useAppStore.getState, activeFile, {
          filePath: document.filePath,
          worktreePath
        })
        const stats = await statRuntimePath(acquisition.context, document.filePath)
        acquisition.assertCurrent()
        if (stats.isDirectory) {
          await refreshMarkdownDocuments(true)
          return
        }
      } catch {
        await refreshMarkdownDocuments(true)
        return
      }

      if (options.anchor || activeFile.mode === 'markdown-preview' || viewMode === 'preview') {
        // Preserve the reading surface; fragments only choose a heading within it.
        openMarkdownPreview(
          {
            filePath: document.filePath,
            relativePath: document.relativePath,
            worktreeId,
            language: 'markdown',
            runtimeEnvironmentId: acquisition.provenance.generation.route.runtimeEnvironmentId,
            operationProvenance: acquisition.provenance
          },
          { anchor: options.anchor }
        )
        return
      }

      openFile({
        filePath: document.filePath,
        relativePath: document.relativePath,
        worktreeId,
        language: 'markdown',
        runtimeEnvironmentId: acquisition.provenance.generation.route.runtimeEnvironmentId,
        operationProvenance: acquisition.provenance,
        mode: 'edit'
      })
    },
    [
      activeFile,
      openFile,
      openMarkdownPreview,
      refreshMarkdownDocuments,
      viewMode,
      worktreeId,
      worktreePath
    ]
  )

  useEffect(() => {
    if (!isMarkdown) {
      return
    }
    // Mount reads are foreground: errors still surface, but never join a pre-change scan.
    const latestChange = worktreePath
      ? getLatestMarkdownMembershipChangeAt(activeFile.runtimeEnvironmentId, worktreePath)
      : undefined
    void refreshMarkdownDocuments(false, latestChange, false)
    return () => {
      requestRef.current += 1
    }
  }, [
    activeFile.id,
    activeFile.runtimeEnvironmentId,
    isMarkdown,
    viewMode,
    worktreePath,
    refreshMarkdownDocuments
  ])

  useMarkdownDocumentWatchRefresh({
    enabled: isMarkdown && !!worktreeId,
    worktreePath,
    runtimeEnvironmentId: activeFile.runtimeEnvironmentId,
    refresh: refreshMarkdownDocuments,
    isListed
  })

  const markdownDocuments = useMemo(
    () => (snapshot?.key === scopeKey ? snapshot.documents : []),
    [scopeKey, snapshot]
  )

  const previewProps = useMemo(
    () => ({ markdownDocuments, onOpenDocument: openMarkdownDocument }),
    [markdownDocuments, openMarkdownDocument]
  )

  const mdSave = useCallback(
    (content: string) =>
      saveMarkdownAndRefreshDocuments(content, onSave, async () => {
        const relativePath = worktreePath
          ? relativePathInsideRoot(worktreePath, activeFile.filePath)
          : null
        // Saving a listed document cannot change membership; only a new one needs a listing.
        if (relativePath === null || !isListed(relativePath)) {
          await refreshMarkdownDocuments(true)
        }
      }),
    [activeFile.filePath, isListed, onSave, refreshMarkdownDocuments, worktreePath]
  )

  const onOpenDocLink = useCallback(
    (target: string) => {
      const resolution = resolveMarkdownDocLink(target, getMarkdownDocumentIndex(markdownDocuments))
      if (resolution.status === 'resolved') {
        void openMarkdownDocument(resolution.document, {
          anchor: getMarkdownDocLinkAnchor(target)
        })
      }
    },
    [markdownDocuments, openMarkdownDocument]
  )

  return { markdownDocuments, openMarkdownDocument, onOpenDocLink, previewProps, mdSave }
}
