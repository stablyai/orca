import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { Editor } from '@tiptap/react'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { syncDocLinkMenu, type DocLinkMenuState } from './rich-markdown-commands'
import { normalizeEmptyListItems } from './rich-markdown-normalize'
import { syncSlashMenu, type SlashMenuState } from './rich-markdown-slash-commands'
import {
  createRichMarkdownImageResolverContext,
  setRichMarkdownImageResolverContext
} from './rich-markdown-image-context'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { notifyStaleViewEditRejected, staleViewEditEpoch } from './editor-stale-view-edit'

type RichMarkdownProgrammaticSyncOptions = {
  codec: RichMarkdownEditorCodec
  content: string
  docLinkMenuSetter: Dispatch<SetStateAction<DocLinkMenuState | null>>
  editor: Editor | null
  fileId: string
  filePath: string
  externalSshTargetId?: string
  isApplyingProgrammaticUpdateRef: MutableRefObject<boolean>
  lastCommittedMarkdownRef: MutableRefObject<string>
  onContentChangeRef: MutableRefObject<(content: string) => void>
  originalSourceRef: MutableRefObject<string>
  baseCanonicalRef: MutableRefObject<string>
  markdownDocuments?: MarkdownDocument[]
  rootRef: MutableRefObject<HTMLDivElement | null>
  runtimeTarget: RuntimeClientTarget | null
  /** Pending debounced commit, based on the text this view last synced. */
  serializeTimerRef: MutableRefObject<number | null>
  pendingEditEpochRef: MutableRefObject<number>
  slashMenuSetter: Dispatch<SetStateAction<SlashMenuState | null>>
  worktreeId: string
  worktreeRoot: string | null
}

type RichMarkdownEditorStorage = {
  markdownDocLink: {
    documents: MarkdownDocument[]
  }
}

export function useRichMarkdownProgrammaticSync({
  codec,
  content,
  docLinkMenuSetter,
  editor,
  fileId,
  filePath,
  externalSshTargetId,
  isApplyingProgrammaticUpdateRef,
  lastCommittedMarkdownRef,
  onContentChangeRef,
  originalSourceRef,
  baseCanonicalRef,
  markdownDocuments,
  rootRef,
  runtimeTarget,
  serializeTimerRef,
  pendingEditEpochRef,
  slashMenuSetter,
  worktreeId,
  worktreeRoot
}: RichMarkdownProgrammaticSyncOptions): void {
  useEffect(() => {
    if (!editor) {
      return
    }
    isApplyingProgrammaticUpdateRef.current = true
    try {
      setRichMarkdownImageResolverContext(
        editor,
        createRichMarkdownImageResolverContext({
          filePath,
          externalSshTargetId,
          runtimeTarget,
          worktreeId,
          worktreeRoot
        })
      )
    } finally {
      isApplyingProgrammaticUpdateRef.current = false
    }
  }, [
    editor,
    externalSshTargetId,
    filePath,
    isApplyingProgrammaticUpdateRef,
    runtimeTarget,
    worktreeId,
    worktreeRoot
  ])

  useEffect(() => {
    if (!editor || !markdownDocuments) {
      return
    }
    isApplyingProgrammaticUpdateRef.current = true
    try {
      const storage = editor.storage as unknown as RichMarkdownEditorStorage
      storage.markdownDocLink.documents = markdownDocuments
      editor.view.dispatch(editor.state.tr.setMeta('docLinksUpdated', true))
    } finally {
      isApplyingProgrammaticUpdateRef.current = false
    }
  }, [editor, isApplyingProgrammaticUpdateRef, markdownDocuments])

  useEffect(() => {
    if (!editor) {
      return
    }
    const editEpoch = pendingEditEpochRef.current
    const discarded = staleViewEditEpoch(fileId) !== editEpoch
    const pendingTimer = serializeTimerRef.current
    if (content === lastCommittedMarkdownRef.current && !(pendingTimer !== null && discarded)) {
      return
    }
    const matchesSharedText = editor.getMarkdown() === content
    if (pendingTimer !== null) {
      window.clearTimeout(pendingTimer)
      serializeTimerRef.current = null
      if (!discarded && !matchesSharedText) {
        notifyStaleViewEditRejected(fileId, editEpoch)
      }
    }
    if (matchesSharedText) {
      // Adopt fresh source bytes without replacing an already matching document.
      lastCommittedMarkdownRef.current = content
      originalSourceRef.current = content
      baseCanonicalRef.current = content
      if (pendingTimer !== null) {
        onContentChangeRef.current(content)
      }
      return
    }
    isApplyingProgrammaticUpdateRef.current = true
    try {
      applyExternalRichMarkdownContent(
        editor,
        content,
        lastCommittedMarkdownRef,
        originalSourceRef,
        baseCanonicalRef,
        codec
      )
    } finally {
      isApplyingProgrammaticUpdateRef.current = false
    }
    if (pendingTimer !== null) {
      // Why: republishing the shared text recomputes the dirty flag this view's typing raised.
      onContentChangeRef.current(content)
    }
    syncSlashMenu(editor, rootRef.current, slashMenuSetter)
    syncDocLinkMenu(editor, rootRef.current, docLinkMenuSetter)
  }, [
    content,
    codec,
    docLinkMenuSetter,
    editor,
    fileId,
    isApplyingProgrammaticUpdateRef,
    lastCommittedMarkdownRef,
    onContentChangeRef,
    pendingEditEpochRef,
    originalSourceRef,
    baseCanonicalRef,
    rootRef,
    serializeTimerRef,
    slashMenuSetter
  ])
}

function applyExternalRichMarkdownContent(
  editor: Editor,
  content: string,
  lastCommittedMarkdownRef: MutableRefObject<string>,
  originalSourceRef: MutableRefObject<string>,
  baseCanonicalRef: MutableRefObject<string>,
  codec: RichMarkdownEditorCodec
): void {
  try {
    const hadFocus = editor.isFocused
    const { from: prevFrom, to: prevTo } = editor.state.selection
    // Exclude other views’ edits/reloads from this view’s undo so it cannot revert or resurrect their text.
    editor
      .chain()
      .setMeta('addToHistory', false)
      .setContent(
        encodeRawMarkdownHtmlForRichEditor(content, codec, { htmlSuperscriptLinks: true }),
        {
          contentType: 'markdown',
          emitUpdate: false
        }
      )
      .run()
    // Normalize empty lists without splitting soft-wrapped prose, matching initial editor loading.
    normalizeEmptyListItems(editor)
    lastCommittedMarkdownRef.current = content
    // Adopt external source style so later edits cannot revive the pre-reload formatting.
    originalSourceRef.current = content
    baseCanonicalRef.current = editor.getMarkdown()
    if (hadFocus) {
      const docSize = editor.state.doc.content.size
      editor
        .chain()
        .setTextSelection({ from: Math.min(prevFrom, docSize), to: Math.min(prevTo, docSize) })
        .focus()
        .run()
    }
  } catch (err) {
    console.error('[RichMarkdownEditor] failed to apply external content update', err)
  }
}
