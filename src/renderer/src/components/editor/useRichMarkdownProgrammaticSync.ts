import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { Editor } from '@tiptap/react'
import type { MarkdownDocument } from '../../../../shared/types'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { syncDocLinkMenu, type DocLinkMenuState } from './rich-markdown-commands'
import { normalizeSoftBreaks } from './rich-markdown-normalize'
import { syncSlashMenu, type SlashMenuState } from './rich-markdown-slash-commands'
import {
  createRichMarkdownImageResolverContext,
  setRichMarkdownImageResolverContext,
  type RichMarkdownImageResolverSettings
} from './rich-markdown-image-context'

type RichMarkdownProgrammaticSyncOptions = {
  content: string
  docLinkMenuSetter: Dispatch<SetStateAction<DocLinkMenuState | null>>
  editor: Editor | null
  fileId: string
  filePath: string
  isApplyingProgrammaticUpdateRef: MutableRefObject<boolean>
  lastCommittedMarkdownRef: MutableRefObject<string>
  markdownDocuments?: MarkdownDocument[]
  rootRef: MutableRefObject<HTMLDivElement | null>
  runtimeEnvironmentId?: string | null
  settings: RichMarkdownImageResolverSettings
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
  content,
  docLinkMenuSetter,
  editor,
  fileId,
  filePath,
  isApplyingProgrammaticUpdateRef,
  lastCommittedMarkdownRef,
  markdownDocuments,
  rootRef,
  runtimeEnvironmentId,
  settings,
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
          runtimeEnvironmentId,
          settings,
          worktreeId,
          worktreeRoot
        })
      )
    } finally {
      isApplyingProgrammaticUpdateRef.current = false
    }
  }, [
    editor,
    filePath,
    isApplyingProgrammaticUpdateRef,
    runtimeEnvironmentId,
    settings,
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
    if (content === lastCommittedMarkdownRef.current || editor.getMarkdown() === content) {
      return
    }
    isApplyingProgrammaticUpdateRef.current = true
    try {
      applyExternalRichMarkdownContent(editor, content, lastCommittedMarkdownRef)
    } finally {
      isApplyingProgrammaticUpdateRef.current = false
    }
    syncSlashMenu(editor, rootRef.current, slashMenuSetter)
    syncDocLinkMenu(editor, rootRef.current, docLinkMenuSetter)
  }, [
    content,
    docLinkMenuSetter,
    editor,
    fileId,
    isApplyingProgrammaticUpdateRef,
    lastCommittedMarkdownRef,
    rootRef,
    slashMenuSetter
  ])
}

function applyExternalRichMarkdownContent(
  editor: Editor,
  content: string,
  lastCommittedMarkdownRef: MutableRefObject<string>
): void {
  try {
    const hadFocus = editor.isFocused
    const { from: prevFrom, to: prevTo } = editor.state.selection
    editor.commands.setContent(encodeRawMarkdownHtmlForRichEditor(content), {
      contentType: 'markdown',
      emitUpdate: false
    })
    normalizeSoftBreaks(editor)
    lastCommittedMarkdownRef.current = content
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
