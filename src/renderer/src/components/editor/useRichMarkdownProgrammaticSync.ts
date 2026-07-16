import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { Editor } from '@tiptap/react'
import type { MarkdownDocument } from '../../../../shared/types'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { syncDocLinkMenu, type DocLinkMenuState } from './rich-markdown-commands'
import { normalizeEmptyListItems } from './rich-markdown-normalize'
import { syncSlashMenu, type SlashMenuState } from './rich-markdown-slash-commands'
import {
  createRichMarkdownImageResolverContext,
  setRichMarkdownImageResolverContext,
  type RichMarkdownImageResolverSettings
} from './rich-markdown-image-context'
import type { RichMarkdownEditorCodec } from './rich-markdown-source-transport'

type RichMarkdownProgrammaticSyncOptions = {
  codec: RichMarkdownEditorCodec
  content: string
  docLinkMenuSetter: Dispatch<SetStateAction<DocLinkMenuState | null>>
  editor: Editor | null
  fileId: string
  filePath: string
  isApplyingProgrammaticUpdateRef: MutableRefObject<boolean>
  lastCommittedMarkdownRef: MutableRefObject<string>
  originalSourceRef: MutableRefObject<string>
  baseCanonicalRef: MutableRefObject<string>
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
  codec,
  content,
  docLinkMenuSetter,
  editor,
  fileId,
  filePath,
  isApplyingProgrammaticUpdateRef,
  lastCommittedMarkdownRef,
  originalSourceRef,
  baseCanonicalRef,
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
    if (content === lastCommittedMarkdownRef.current) {
      return
    }
    if (editor.getMarkdown() === content) {
      // Why: disk bytes changed but already render-equal to the current doc (e.g.
      // an external tool canonicalized byte-level style). Skip the disruptive
      // reload, but adopt the new bytes as the reconciliation baseline so the next
      // edit patches onto the fresh source, not the stale pre-change source.
      lastCommittedMarkdownRef.current = content
      originalSourceRef.current = content
      baseCanonicalRef.current = content
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
    originalSourceRef,
    baseCanonicalRef,
    rootRef,
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
    editor.commands.setContent(
      encodeRawMarkdownHtmlForRichEditor(content, codec, { htmlSuperscriptLinks: true }),
      {
        contentType: 'markdown',
        emitUpdate: false
      }
    )
    // Why: normalizeEmptyListItems avoids splitting hard-wrapped paragraphs from
    // external content, matching onCreate's single-paragraph reflow behavior.
    normalizeEmptyListItems(editor)
    lastCommittedMarkdownRef.current = content
    // Why: reset the reconciliation baseline to the freshly loaded external bytes
    // so subsequent edits preserve the new source style, not the pre-reload one.
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
