import { useCallback, useMemo, type RefObject } from 'react'
import type { JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import { readTerminalRichInputDraftContent } from './terminal-rich-input-draft'
import {
  terminalRichInputApplyResourceContext,
  terminalRichInputImageAttachments,
  terminalRichInputImageAttachmentsToContent,
  terminalRichInputTextToContent,
  type TerminalRichInputResourceContext
} from './terminal-rich-input-model'
import { useTerminalRichInputAttachments } from './use-terminal-rich-input-attachments'
import type { TerminalRichInputImageAttachment } from './terminal-rich-input-types'

export function useTerminalRichInputEditorAttachments({
  scopeKey,
  initialDraft,
  parseFileReferences,
  connectionId,
  runtimeEnvironmentId,
  worktreeId,
  worktreePath,
  editorRef,
  enabled
}: {
  scopeKey: string
  initialDraft: string
  parseFileReferences: boolean
  connectionId: string | null
  runtimeEnvironmentId: string | null
  worktreeId: string
  worktreePath: string
  editorRef: RefObject<Editor | null>
  enabled: boolean
}): ReturnType<typeof useTerminalRichInputAttachments> & {
  initialContent: JSONContent
  resourceContext: TerminalRichInputResourceContext
  syncEditorAttachments: (content: JSONContent) => void
} {
  const resourceContext = useMemo(
    () => ({ connectionId, runtimeEnvironmentId, worktreeId, worktreePath }),
    [connectionId, runtimeEnvironmentId, worktreeId, worktreePath]
  )
  const initialContent = useMemo(() => {
    const persistedContent = readTerminalRichInputDraftContent(scopeKey)
    return persistedContent
      ? terminalRichInputApplyResourceContext(persistedContent, resourceContext)
      : terminalRichInputTextToContent(initialDraft, parseFileReferences, resourceContext)
  }, [initialDraft, parseFileReferences, resourceContext, scopeKey])
  const insertAddedAttachments = useCallback(
    (added: readonly TerminalRichInputImageAttachment[], insertionPosition?: number) => {
      const editor = editorRef.current
      if (!editor || added.length === 0) {
        return
      }
      const position = resolveTerminalRichInputInsertionPosition(
        editor.state.doc,
        insertionPosition ?? editor.state.selection.from
      )
      editor
        .chain()
        .focus()
        .insertContentAt(
          position,
          terminalRichInputImageAttachmentsToContent(added, resourceContext)
        )
        .run()
    },
    [editorRef, resourceContext]
  )
  const attachmentState = useTerminalRichInputAttachments({
    scopeKey,
    initialContent,
    connectionId,
    runtimeEnvironmentId,
    focusEditor: () => editorRef.current?.commands.focus(),
    onAttachmentsAdded: insertAddedAttachments,
    enabled
  })
  const { syncAttachments } = attachmentState
  const syncEditorAttachments = useCallback(
    (content: JSONContent) => {
      syncAttachments(terminalRichInputImageAttachments(content))
    },
    [syncAttachments]
  )

  return {
    ...attachmentState,
    initialContent,
    resourceContext,
    syncEditorAttachments
  }
}

export function resolveTerminalRichInputInsertionPosition(
  doc: ProseMirrorNode,
  requestedPosition: number
): number {
  const clampedPosition = Math.max(0, Math.min(requestedPosition, doc.content.size))
  return TextSelection.near(doc.resolve(clampedPosition), -1).from
}
