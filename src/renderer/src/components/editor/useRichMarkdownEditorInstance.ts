import { type Dispatch, type MutableRefObject, type SetStateAction, useMemo } from 'react'
import { useEditor, type Editor } from '@tiptap/react'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownKeyHandler } from './rich-markdown-key-handler'
import { handleRichMarkdownCut } from './rich-markdown-cut-handler'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { normalizeSoftBreaks } from './rich-markdown-normalize'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'
import {
  syncDocLinkMenu,
  type DocLinkMenuRow,
  type DocLinkMenuState
} from './rich-markdown-commands'
import {
  syncSlashMenu,
  type SlashCommand,
  type SlashMenuState
} from './rich-markdown-slash-commands'
import { isSingleEmptyTopLevelOrderedList } from './rich-markdown-list-continuation'
import { getLinkBubblePosition, type LinkBubbleState } from './RichMarkdownLinkBubble'
import {
  handleRichMarkdownEditorClick,
  type ActivateMarkdownLink,
  type RichMarkdownRuntimeSettings
} from './rich-markdown-editor-click-routing'
import type { DiffComment } from '../../../../shared/types'

const richMarkdownExtensions = createRichMarkdownExtensions({ includePlaceholder: true })

export function useRichMarkdownEditorInstance({
  content,
  filePath,
  worktreeId,
  worktreeRoot,
  runtimeEnvironmentId,
  isMac,
  settings,
  activateMarkdownLink,
  rootRef,
  editorRef,
  lastCommittedMarkdownRef,
  onContentChangeRef,
  onDirtyStateHintRef,
  onSaveRef,
  onOpenDocLinkRef,
  isEditingLinkRef,
  slashMenuRef,
  filteredSlashCommandsRef,
  selectedCommandIndexRef,
  docLinkMenuRef,
  filteredDocLinkRowsRef,
  selectedDocLinkIndexRef,
  handleLocalImagePickRef,
  handleEmojiPickRef,
  typedEmptyOrderedListMarkerRef,
  cancelAutoFocusRef,
  serializeTimerRef,
  isInitializingRef,
  isApplyingProgrammaticUpdateRef,
  markdownCommentsRef,
  markdownSourceLineOffsetRef,
  flushPendingSerialization,
  openSearchRef,
  syncAnnotationTarget,
  clearAnnotationTarget,
  scrollRichMarkdownReviewNoteCardIntoView,
  setIsEditingLink,
  setLinkBubble,
  setSelectedCommandIndex,
  setSelectedDocLinkIndex,
  setSlashMenu,
  setDocLinkMenu
}: {
  content: string
  filePath: string
  worktreeId: string
  worktreeRoot: string | null
  runtimeEnvironmentId?: string | null
  isMac: boolean
  settings: RichMarkdownRuntimeSettings
  activateMarkdownLink: ActivateMarkdownLink
  rootRef: MutableRefObject<HTMLDivElement | null>
  editorRef: MutableRefObject<Editor | null>
  lastCommittedMarkdownRef: MutableRefObject<string>
  onContentChangeRef: MutableRefObject<(content: string) => void>
  onDirtyStateHintRef: MutableRefObject<(dirty: boolean) => void>
  onSaveRef: MutableRefObject<(content: string) => void>
  onOpenDocLinkRef: MutableRefObject<((target: string) => void) | undefined>
  isEditingLinkRef: MutableRefObject<boolean>
  slashMenuRef: MutableRefObject<SlashMenuState | null>
  filteredSlashCommandsRef: MutableRefObject<SlashCommand[]>
  selectedCommandIndexRef: MutableRefObject<number>
  docLinkMenuRef: MutableRefObject<DocLinkMenuState | null>
  filteredDocLinkRowsRef: MutableRefObject<DocLinkMenuRow[]>
  selectedDocLinkIndexRef: MutableRefObject<number>
  handleLocalImagePickRef: MutableRefObject<() => void>
  handleEmojiPickRef: MutableRefObject<(menu: SlashMenuState) => void>
  typedEmptyOrderedListMarkerRef: MutableRefObject<boolean>
  cancelAutoFocusRef: MutableRefObject<(() => void) | null>
  serializeTimerRef: MutableRefObject<number | null>
  isInitializingRef: MutableRefObject<boolean>
  isApplyingProgrammaticUpdateRef: MutableRefObject<boolean>
  markdownCommentsRef: MutableRefObject<DiffComment[]>
  markdownSourceLineOffsetRef: MutableRefObject<number>
  flushPendingSerialization: () => void
  openSearchRef: MutableRefObject<() => void>
  syncAnnotationTarget: (editor: Editor) => void
  clearAnnotationTarget: () => void
  scrollRichMarkdownReviewNoteCardIntoView: (commentId: string) => void
  setIsEditingLink: Dispatch<SetStateAction<boolean>>
  setLinkBubble: Dispatch<SetStateAction<LinkBubbleState | null>>
  setSelectedCommandIndex: Dispatch<SetStateAction<number>>
  setSelectedDocLinkIndex: Dispatch<SetStateAction<number>>
  setSlashMenu: Dispatch<SetStateAction<SlashMenuState | null>>
  setDocLinkMenu: Dispatch<SetStateAction<DocLinkMenuState | null>>
}): Editor | null {
  const editor = useEditor(
    useMemo(
      () => ({
        immediatelyRender: false,
        extensions: richMarkdownExtensions,
        content: encodeRawMarkdownHtmlForRichEditor(content),
        contentType: 'markdown' as const,
        editorProps: {
          attributes: {
            class: 'rich-markdown-editor',
            spellcheck: 'true'
          },
          handleDOMEvents: {
            cut: handleRichMarkdownCut
          },
          handlePaste: (_view, event) =>
            handleRichMarkdownPaste({
              editor: editorRef.current,
              event,
              filePath,
              worktreeId,
              runtimeEnvironmentId
            }),
          handleTextInput: (view, from, to, text) => {
            typedEmptyOrderedListMarkerRef.current = false
            if (text !== ' ' || from !== to || !view.state.selection.empty) {
              return false
            }
            const { $from } = view.state.selection
            const beforeCursor = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0')
            typedEmptyOrderedListMarkerRef.current = /^\d+\.$/.test(beforeCursor)
            return false
          },
          handleKeyDown: createRichMarkdownKeyHandler({
            isMac,
            editorRef,
            rootRef,
            lastCommittedMarkdownRef,
            onContentChangeRef,
            onSaveRef,
            isEditingLinkRef,
            slashMenuRef,
            filteredSlashCommandsRef,
            selectedCommandIndexRef,
            docLinkMenuRef,
            filteredDocLinkRowsRef,
            selectedDocLinkIndexRef,
            handleLocalImagePickRef,
            handleEmojiPickRef,
            typedEmptyOrderedListMarkerRef,
            flushPendingSerialization,
            openSearchRef,
            setIsEditingLink,
            setLinkBubble,
            setSelectedCommandIndex,
            setSelectedDocLinkIndex,
            setSlashMenu,
            setDocLinkMenu
          }),
          handleClick: (view, pos, event) => {
            return handleRichMarkdownEditorClick({
              activateMarkdownLink,
              editorRef,
              event,
              filePath,
              isMac,
              markdownCommentsRef,
              markdownSourceLineOffsetRef,
              onOpenDocLinkRef,
              pos,
              rootRef,
              runtimeEnvironmentId,
              scrollRichMarkdownReviewNoteCardIntoView,
              settings,
              view,
              worktreeId,
              worktreeRoot
            })
          }
        },
        onFocus: () => {
          window.api.ui.setMarkdownEditorFocused(true)
        },
        onBlur: () => {
          window.api.ui.setMarkdownEditorFocused(false)
          clearAnnotationTarget()
        },
        onCreate: ({ editor: nextEditor }) => {
          normalizeSoftBreaks(nextEditor)
          lastCommittedMarkdownRef.current = content
          isInitializingRef.current = false
          cancelAutoFocusRef.current?.()
          cancelAutoFocusRef.current = autoFocusRichEditor(nextEditor, rootRef.current)
        },
        onUpdate: ({ editor: nextEditor }) => {
          syncSlashMenu(nextEditor, rootRef.current, setSlashMenu)
          syncDocLinkMenu(nextEditor, rootRef.current, setDocLinkMenu)
          if (!isSingleEmptyTopLevelOrderedList(nextEditor)) {
            typedEmptyOrderedListMarkerRef.current = false
          }
          if (isInitializingRef.current || isApplyingProgrammaticUpdateRef.current) {
            return
          }
          onDirtyStateHintRef.current(true)
          if (serializeTimerRef.current !== null) {
            window.clearTimeout(serializeTimerRef.current)
          }
          serializeTimerRef.current = window.setTimeout(() => {
            serializeTimerRef.current = null
            try {
              const markdown = nextEditor.getMarkdown()
              lastCommittedMarkdownRef.current = markdown
              onContentChangeRef.current(markdown)
            } catch {
              // Why: save/restart flows should never crash the UI just because
              // the editor was torn down between scheduling and serializing.
            }
          }, 300)
        },
        onSelectionUpdate: ({ editor: nextEditor }) => {
          syncSlashMenu(nextEditor, rootRef.current, setSlashMenu)
          syncDocLinkMenu(nextEditor, rootRef.current, setDocLinkMenu)
          syncAnnotationTarget(nextEditor)
          setIsEditingLink(false)
          if (nextEditor.isActive('link')) {
            const attrs = nextEditor.getAttributes('link')
            const pos = getLinkBubblePosition(nextEditor, rootRef.current)
            setLinkBubble(pos ? { href: (attrs.href as string) || '', ...pos } : null)
          } else {
            setLinkBubble(null)
          }
        }
      }),
      [
        activateMarkdownLink,
        cancelAutoFocusRef,
        clearAnnotationTarget,
        content,
        docLinkMenuRef,
        editorRef,
        filePath,
        filteredDocLinkRowsRef,
        filteredSlashCommandsRef,
        flushPendingSerialization,
        handleEmojiPickRef,
        handleLocalImagePickRef,
        isApplyingProgrammaticUpdateRef,
        isEditingLinkRef,
        isInitializingRef,
        isMac,
        lastCommittedMarkdownRef,
        markdownCommentsRef,
        markdownSourceLineOffsetRef,
        onContentChangeRef,
        onDirtyStateHintRef,
        onOpenDocLinkRef,
        onSaveRef,
        openSearchRef,
        rootRef,
        runtimeEnvironmentId,
        scrollRichMarkdownReviewNoteCardIntoView,
        selectedCommandIndexRef,
        selectedDocLinkIndexRef,
        serializeTimerRef,
        setDocLinkMenu,
        setIsEditingLink,
        setLinkBubble,
        setSelectedCommandIndex,
        setSelectedDocLinkIndex,
        setSlashMenu,
        settings,
        slashMenuRef,
        syncAnnotationTarget,
        typedEmptyOrderedListMarkerRef,
        worktreeId,
        worktreeRoot
      ]
    )
  )
  editorRef.current = editor ?? null
  return editor
}
