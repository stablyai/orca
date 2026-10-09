import { toast } from 'sonner'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { statRuntimePath } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import {
  createMarkdownDocumentIndex,
  getMarkdownDocLinkAnchor,
  resolveMarkdownDocLink
} from './markdown-doc-links'
import { selectMarkdownDocumentWorktreePath } from './markdown-document-worktree-path-selector'
import { requestSharedMarkdownDocumentList } from './markdown-document-list-request'
import { findRestoredEditorWorkspaceRuntimeOwner } from './restored-editor-workspace-runtime-owner'
import { useMarkdownDocumentWatchRefresh } from './use-markdown-document-watch-refresh'

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
  // Why: PTY activity replaces worktree metadata; only a routing-path change
  // should wake every mounted editor's document-link controller.
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

  const refreshMarkdownDocuments = useCallback(
    async (requireFresh = false, freshAfter?: number): Promise<void> => {
      if (!worktreeId || !worktreePath) {
        return
      }
      const state = useAppStore.getState()
      const settings = settingsForRuntimeOwner(state.settings, activeFile.runtimeEnvironmentId)
      // The content loader reowns retained tabs before metadata may use their new host.
      if (
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
        (connectionId === undefined && !settings?.activeRuntimeEnvironmentId?.trim())
      ) {
        return
      }

      const requestId = requestRef.current + 1
      requestRef.current = requestId
      try {
        const documents = await requestSharedMarkdownDocumentList(
          {
            settings,
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
        setSnapshot({ key: scopeKey, documents })
      } catch (err) {
        console.error('Failed to list markdown documents:', err)
        // Watcher refreshes are background work: keep the last good list and stay quiet.
        if (freshAfter !== undefined) {
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
      try {
        const stats = await statRuntimePath(
          {
            settings: settingsForRuntimeOwner(
              useAppStore.getState().settings,
              activeFile.runtimeEnvironmentId
            ),
            worktreeId,
            worktreePath,
            connectionId: connectionId ?? undefined
          },
          document.filePath
        )
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
            runtimeEnvironmentId: activeFile.runtimeEnvironmentId
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
        runtimeEnvironmentId: activeFile.runtimeEnvironmentId,
        mode: 'edit'
      })
    },
    [
      activeFile.mode,
      activeFile.runtimeEnvironmentId,
      connectionId,
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
    void refreshMarkdownDocuments()
    return () => {
      requestRef.current += 1
    }
  }, [activeFile.id, isMarkdown, viewMode, refreshMarkdownDocuments])

  useMarkdownDocumentWatchRefresh({
    enabled: isMarkdown && !!worktreeId,
    worktreePath,
    runtimeEnvironmentId: activeFile.runtimeEnvironmentId,
    refresh: refreshMarkdownDocuments
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
      saveMarkdownAndRefreshDocuments(content, onSave, () => refreshMarkdownDocuments(true)),
    [onSave, refreshMarkdownDocuments]
  )

  const docIndex = useMemo(
    () => createMarkdownDocumentIndex(markdownDocuments),
    [markdownDocuments]
  )

  const onOpenDocLink = useCallback(
    (target: string) => {
      const resolution = resolveMarkdownDocLink(target, docIndex)
      if (resolution.status === 'resolved') {
        void openMarkdownDocument(resolution.document, {
          anchor: getMarkdownDocLinkAnchor(target)
        })
      }
    },
    [docIndex, openMarkdownDocument]
  )

  return { markdownDocuments, openMarkdownDocument, onOpenDocLink, previewProps, mdSave }
}
