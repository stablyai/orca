import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MarkdownDocument } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { listRuntimeMarkdownDocuments, statRuntimePath } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import {
  createMarkdownDocumentIndex,
  getMarkdownDocLinkAnchor,
  resolveMarkdownDocLink
} from './markdown-doc-links'
import { selectMarkdownDocumentWorktreePath } from './markdown-document-worktree-path-selector'

type OpenMarkdownDocumentOptions = {
  anchor?: string | null
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
  mdSave: (content: string) => Promise<void>
}

export function useMarkdownDocuments(
  activeFile: OpenFile,
  isMarkdown: boolean,
  viewMode: MarkdownViewMode,
  onSave: (content: string) => Promise<void>
): UseMarkdownDocumentsResult {
  const worktreeId = activeFile.worktreeId
  // Why: PTY activity replaces worktree metadata; only a routing-path change
  // should wake every mounted editor's document-link controller.
  const worktreePath = useAppStore((s) => selectMarkdownDocumentWorktreePath(s, worktreeId))
  const openFile = useAppStore((s) => s.openFile)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const [markdownDocumentsByWorktree, setMarkdownDocumentsByWorktree] = useState<
    Record<string, MarkdownDocument[]>
  >({})
  const requestRef = useRef(0)

  const connectionId = getConnectionId(worktreeId)

  const refreshMarkdownDocuments = useCallback(async (): Promise<void> => {
    if (!worktreeId || !worktreePath) {
      return
    }

    const requestId = requestRef.current + 1
    requestRef.current = requestId
    try {
      const documents = await listRuntimeMarkdownDocuments(
        {
          settings: settingsForRuntimeOwner(
            useAppStore.getState().settings,
            activeFile.runtimeEnvironmentId
          ),
          worktreeId,
          worktreePath,
          connectionId: connectionId ?? undefined
        },
        worktreePath
      )
      if (requestRef.current !== requestId) {
        return
      }
      setMarkdownDocumentsByWorktree((prev) => ({
        ...prev,
        [worktreeId]: documents
      }))
    } catch (err) {
      console.error('Failed to list markdown documents:', err)
      if (requestRef.current === requestId) {
        setMarkdownDocumentsByWorktree((prev) => ({
          ...prev,
          [worktreeId]: []
        }))
      }
    }
  }, [activeFile.runtimeEnvironmentId, connectionId, worktreeId, worktreePath])

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
          await refreshMarkdownDocuments()
          return
        }
      } catch {
        await refreshMarkdownDocuments()
        return
      }

      if (options.anchor) {
        // Why: heading fragments are preview anchors, not filesystem paths.
        // Opening preview preserves Obsidian-style [[note#Heading]] navigation.
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
      activeFile.runtimeEnvironmentId,
      connectionId,
      openFile,
      openMarkdownPreview,
      refreshMarkdownDocuments,
      worktreeId,
      worktreePath
    ]
  )

  useEffect(() => {
    if (!isMarkdown) {
      return
    }
    void refreshMarkdownDocuments()
  }, [activeFile.id, isMarkdown, viewMode, refreshMarkdownDocuments])

  const markdownDocuments = useMemo(
    () => (worktreeId ? (markdownDocumentsByWorktree[worktreeId] ?? []) : []),
    [worktreeId, markdownDocumentsByWorktree]
  )

  const previewProps = useMemo(
    () => ({ markdownDocuments, onOpenDocument: openMarkdownDocument }),
    [markdownDocuments, openMarkdownDocument]
  )

  const mdSave = useCallback(
    (content: string) => onSave(content).then(() => refreshMarkdownDocuments()),
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
