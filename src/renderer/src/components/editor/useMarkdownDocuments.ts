import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
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
import { isMarkdownDocumentCapacityError } from './rich-markdown-ipc-error-message'
import {
  getMarkdownDocumentListRequestKey,
  requestSharedMarkdownDocumentList
} from './markdown-document-list-request'

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
  const [documentSnapshot, setDocumentSnapshot] = useState<{
    requestKey: string
    documents: MarkdownDocument[]
  } | null>(null)
  const requestRef = useRef(0)

  const connectionId = getConnectionId(worktreeId)
  const documentRequestKey = getMarkdownDocumentListRequestKey(
    {
      settings: settingsForRuntimeOwner(
        useAppStore.getState().settings,
        activeFile.runtimeEnvironmentId
      ),
      worktreeId,
      worktreePath: worktreePath ?? undefined,
      connectionId: connectionId ?? undefined
    },
    worktreePath ?? ''
  )
  const currentRequestKeyRef = useRef<string | null>(documentRequestKey)
  const lastCapacityNoticeKeyRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (currentRequestKeyRef.current !== documentRequestKey) {
      lastCapacityNoticeKeyRef.current = null
    }
    currentRequestKeyRef.current = documentRequestKey
  }, [documentRequestKey])
  // Suspense hides layout effects while a current scan is still valid.
  useEffect(
    () => () => {
      currentRequestKeyRef.current = null
    },
    []
  )

  const refreshMarkdownDocuments = useCallback(
    async (requireFresh = false): Promise<void> => {
      if (!worktreeId || !worktreePath || currentRequestKeyRef.current !== documentRequestKey) {
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
        if (
          requestRef.current !== requestId ||
          currentRequestKeyRef.current !== documentRequestKey
        ) {
          return
        }
        lastCapacityNoticeKeyRef.current = null
        setDocumentSnapshot({ requestKey: documentRequestKey, documents })
      } catch (err) {
        console.error('Failed to list markdown documents:', err)
        if (
          requestRef.current === requestId &&
          currentRequestKeyRef.current === documentRequestKey
        ) {
          setDocumentSnapshot({ requestKey: documentRequestKey, documents: [] })
          if (
            isMarkdownDocumentCapacityError(err) &&
            lastCapacityNoticeKeyRef.current !== documentRequestKey
          ) {
            lastCapacityNoticeKeyRef.current = documentRequestKey
            toast.error(
              translate(
                'editor.markdownLinks.capacity',
                'Markdown links are unavailable because this workspace is too large.'
              ),
              { id: `markdown-document-capacity:${documentRequestKey}` }
            )
          }
        }
      }
    },
    [activeFile.runtimeEnvironmentId, connectionId, documentRequestKey, worktreeId, worktreePath]
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
  }, [activeFile.id, isMarkdown, viewMode, refreshMarkdownDocuments])

  const markdownDocuments = useMemo(
    () => (documentSnapshot?.requestKey === documentRequestKey ? documentSnapshot.documents : []),
    [documentRequestKey, documentSnapshot]
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
