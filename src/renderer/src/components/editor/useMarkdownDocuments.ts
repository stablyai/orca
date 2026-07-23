import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { MarkdownDocument } from '../../../../shared/types'
import {
  isMarkdownDocumentListingCapacityError,
  MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE
} from '../../../../shared/markdown-document-listing-limits'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
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
import {
  retainMarkdownDocumentWorktreeSnapshot,
  type MarkdownDocumentWorktreeSnapshot
} from './markdown-document-worktree-retention'

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
  const [markdownDocumentsByWorktree, setMarkdownDocumentsByWorktree] = useState<
    Map<string, MarkdownDocumentWorktreeSnapshot>
  >(() => new Map())
  const requestRef = useRef(0)

  const connectionId = getConnectionId(worktreeId)

  const refreshMarkdownDocuments = useCallback(
    async (requireFresh = false): Promise<void> => {
      if (!worktreeId || !worktreePath) {
        return
      }

      const requestId = requestRef.current + 1
      requestRef.current = requestId
      try {
        const documents = await requestSharedMarkdownDocumentList(
          {
            settings: settingsForRuntimeOwner(
              useAppStore.getState().settings,
              activeFile.runtimeEnvironmentId
            ),
            worktreeId,
            worktreePath,
            connectionId: connectionId ?? undefined
          },
          worktreePath,
          { requireFresh }
        )
        if (requestRef.current !== requestId) {
          return
        }
        setMarkdownDocumentsByWorktree((prev) =>
          retainMarkdownDocumentWorktreeSnapshot(prev, worktreeId, documents)
        )
      } catch (err) {
        console.error('Failed to list markdown documents:', err)
        if (requestRef.current === requestId) {
          if (isMarkdownDocumentListingCapacityError(err)) {
            toast.error(MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE, {
              id: `markdown-document-listing-capacity:${worktreeId}`
            })
          }
          setMarkdownDocumentsByWorktree((prev) =>
            retainMarkdownDocumentWorktreeSnapshot(prev, worktreeId, [])
          )
        }
      }
    },
    [activeFile.runtimeEnvironmentId, connectionId, worktreeId, worktreePath]
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
    () => (worktreeId ? (markdownDocumentsByWorktree.get(worktreeId)?.documents ?? []) : []),
    [worktreeId, markdownDocumentsByWorktree]
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
