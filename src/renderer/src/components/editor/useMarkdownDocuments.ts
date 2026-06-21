import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MarkdownDocument } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getConnectionId } from '@/lib/connection-context'
import { listRuntimeMarkdownDocuments, statRuntimePath } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import { createMissingMarkdownDocLinkDocument } from './markdown-doc-link-create'
import {
  showAmbiguousMarkdownDocLinkToast,
  showCreatedMarkdownDocLinkToast,
  showInvalidMarkdownDocLinkTargetToast,
  showMissingMarkdownDocLinkCreateToast
} from './markdown-doc-link-toasts'
import { createMarkdownDocumentIndex, resolveMarkdownDocLink } from './markdown-doc-links'

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
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const openFile = useAppStore((s) => s.openFile)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const [markdownDocumentsByWorktree, setMarkdownDocumentsByWorktree] = useState<
    Record<string, MarkdownDocument[]>
  >({})
  const markdownDocumentsByWorktreeRef = useRef(markdownDocumentsByWorktree)
  const requestRef = useRef(0)
  markdownDocumentsByWorktreeRef.current = markdownDocumentsByWorktree

  const worktreePath = useMemo(() => {
    if (!worktreeId) {
      return null
    }
    return findWorktreeById(worktreesByRepo, worktreeId)?.path ?? null
  }, [worktreeId, worktreesByRepo])

  const connectionId = getConnectionId(worktreeId)

  const refreshMarkdownDocuments = useCallback(async (): Promise<MarkdownDocument[]> => {
    if (!worktreeId || !worktreePath) {
      return []
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
        return markdownDocumentsByWorktreeRef.current[worktreeId] ?? []
      }
      setMarkdownDocumentsByWorktree((prev) => ({
        ...prev,
        [worktreeId]: documents
      }))
      return documents
    } catch (err) {
      console.error('Failed to list markdown documents:', err)
      if (requestRef.current === requestId) {
        setMarkdownDocumentsByWorktree((prev) => ({
          ...prev,
          [worktreeId]: []
        }))
      }
      return []
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
    async (content: string) => {
      await onSave(content)
      await refreshMarkdownDocuments()
    },
    [onSave, refreshMarkdownDocuments]
  )

  const docIndex = useMemo(
    () => createMarkdownDocumentIndex(markdownDocuments),
    [markdownDocuments]
  )

  const createAndOpenMissingDocLink = useCallback(
    async (target: string): Promise<void> => {
      if (!worktreeId || !worktreePath) {
        return
      }
      const createdDocument = await createMissingMarkdownDocLinkDocument({
        context: {
          settings: settingsForRuntimeOwner(
            useAppStore.getState().settings,
            activeFile.runtimeEnvironmentId
          ),
          worktreeId,
          worktreePath,
          connectionId: connectionId ?? undefined
        },
        target,
        worktreePath
      })
      if (!createdDocument) {
        showInvalidMarkdownDocLinkTargetToast()
        return
      }

      await refreshMarkdownDocuments()
      await openMarkdownDocument(createdDocument)
      showCreatedMarkdownDocLinkToast(createdDocument.relativePath)
    },
    [
      activeFile.runtimeEnvironmentId,
      connectionId,
      openMarkdownDocument,
      refreshMarkdownDocuments,
      worktreeId,
      worktreePath
    ]
  )

  const onOpenDocLink = useCallback(
    (target: string) => {
      void (async () => {
        let resolution = resolveMarkdownDocLink(target, docIndex)
        if (resolution.status !== 'resolved') {
          const refreshedDocuments = await refreshMarkdownDocuments()
          resolution = resolveMarkdownDocLink(
            target,
            createMarkdownDocumentIndex(refreshedDocuments)
          )
        }
        if (resolution.status === 'resolved') {
          await openMarkdownDocument(resolution.document)
          return
        }
        if (resolution.status === 'missing') {
          showMissingMarkdownDocLinkCreateToast({
            onCreate: createAndOpenMissingDocLink,
            target
          })
          return
        }
        if (resolution.status === 'ambiguous') {
          showAmbiguousMarkdownDocLinkToast(resolution.matches)
        }
      })()
    },
    [createAndOpenMissingDocLink, docIndex, openMarkdownDocument, refreshMarkdownDocuments]
  )

  return { markdownDocuments, openMarkdownDocument, onOpenDocLink, previewProps, mdSave }
}
