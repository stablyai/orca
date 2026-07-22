import type { Editor, UseEditorOptions } from '@tiptap/react'
import { handleRichMarkdownCut } from './rich-markdown-cut-handler'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { normalizeEmptyListItems } from './rich-markdown-normalize'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'
import {
  syncSlashMenu,
  type SlashCommand,
  type SlashMenuState
} from './rich-markdown-slash-commands'
import {
  syncDocLinkMenu,
  type DocLinkMenuRow,
  type DocLinkMenuState
} from './rich-markdown-commands'
import { isSingleEmptyTopLevelOrderedList } from './rich-markdown-list-continuation'
import type { LinkBubbleState } from './RichMarkdownLinkBubble'
import {
  handleRichMarkdownEditorClick,
  type ActivateMarkdownLink,
  type RichMarkdownRuntimeSettings
} from './rich-markdown-editor-click-routing'
import { createRichMarkdownKeyHandler } from './rich-markdown-key-handler'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'
import {
  createRichMarkdownImageResolverContext,
  setRichMarkdownImageResolverContext
} from './rich-markdown-image-context'
import { getRichMarkdownSpellcheckAttribute } from './rich-markdown-spellcheck'
import type { MutableRefObject, Dispatch, SetStateAction } from 'react'
import type { DiffComment } from '../../../../shared/types'
import type { RichMarkdownEditorCodec } from './rich-markdown-source-transport'
import type { RichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import {
  getRichMarkdownSelectionLinkBubble,
  openSelectedHtmlSuperscriptLink
} from './rich-markdown-selected-link-actions'

export type EditorConfigParams = {
  codec: RichMarkdownEditorCodec
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
  content: string
  filePath: string
  worktreeId: string
  worktreeRoot: string | null
  runtimeEnvironmentId?: string | null
  isMac: boolean
  richMarkdownSpellcheckEnabled: boolean
  settings: RichMarkdownRuntimeSettings
  activateMarkdownLink: ActivateMarkdownLink
  rootRef: MutableRefObject<HTMLDivElement | null>
  editorRef: MutableRefObject<Editor | null>
  lastCommittedMarkdownRef: MutableRefObject<string>
  originalSourceRef: MutableRefObject<string>
  baseCanonicalRef: MutableRefObject<string>
  reconcileRoundTripRef: MutableRefObject<(markdown: string) => string | null>
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
  openAnnotationPopoverRef: MutableRefObject<(requireLiveSelection?: boolean) => boolean>
  syncAnnotationTarget: (editor: Editor) => void
  clearAnnotationTarget: () => void
  scrollRichMarkdownReviewNoteCardIntoView: (commentId: string) => void
  setIsEditingLink: Dispatch<SetStateAction<boolean>>
  setLinkBubble: Dispatch<SetStateAction<LinkBubbleState | null>>
  setSelectedCommandIndex: Dispatch<SetStateAction<number>>
  setSelectedDocLinkIndex: Dispatch<SetStateAction<number>>
  setSlashMenu: Dispatch<SetStateAction<SlashMenuState | null>>
  setDocLinkMenu: Dispatch<SetStateAction<DocLinkMenuState | null>>
}

export function createRichMarkdownEditorConfig(params: EditorConfigParams): UseEditorOptions {
  const {
    content,
    codec,
    htmlSuperscriptLinkContext,
    filePath,
    worktreeId,
    worktreeRoot,
    runtimeEnvironmentId,
    isMac,
    richMarkdownSpellcheckEnabled,
    settings,
    activateMarkdownLink,
    rootRef,
    editorRef,
    lastCommittedMarkdownRef,
    originalSourceRef,
    baseCanonicalRef,
    reconcileRoundTripRef,
    onContentChangeRef,
    onDirtyStateHintRef,
    onOpenDocLinkRef,
    typedEmptyOrderedListMarkerRef,
    cancelAutoFocusRef,
    serializeTimerRef,
    isInitializingRef,
    isApplyingProgrammaticUpdateRef,
    markdownCommentsRef,
    markdownSourceLineOffsetRef,
    syncAnnotationTarget,
    clearAnnotationTarget,
    scrollRichMarkdownReviewNoteCardIntoView,
    setIsEditingLink,
    setLinkBubble,
    setSlashMenu,
    setDocLinkMenu
  } = params

  return {
    immediatelyRender: false,
    content: encodeRawMarkdownHtmlForRichEditor(content, codec, { htmlSuperscriptLinks: true }),
    contentType: 'markdown' as const,
    editorProps: {
      attributes: {
        class: 'rich-markdown-editor',
        spellcheck: getRichMarkdownSpellcheckAttribute(richMarkdownSpellcheckEnabled)
      },
      handleDOMEvents: {
        cut: handleRichMarkdownCut
      },
      handlePaste: (view, event, slice) =>
        handleRichMarkdownPaste({
          editor: editorRef.current,
          event,
          filePath,
          worktreeId,
          runtimeEnvironmentId,
          slice,
          view
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
      // Why: KeyHandlerContext is a typed subset of EditorConfigParams, so the
      // spread stays type-checked while new context fields avoid re-listing
      // every ref here.
      handleKeyDown: createRichMarkdownKeyHandler({
        ...params,
        linkBubbleOwnerId: codec.transport.key,
        openSelectedHtmlSuperscriptLink: () =>
          openSelectedHtmlSuperscriptLink({
            activateMarkdownLink,
            context: htmlSuperscriptLinkContext,
            editor: editorRef.current,
            root: rootRef.current,
            runtimeEnvironmentId
          })
      }),
      handleClick: (view, pos, event) => {
        return handleRichMarkdownEditorClick({
          activateMarkdownLink,
          editorRef,
          event,
          filePath,
          htmlSuperscriptLinkContext,
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
      // Why: normalizeEmptyListItems (not normalizeSoftBreaks) so hard-wrapped
      // source paragraphs stay one paragraph and reflow via CSS instead of being
      // split on load.
      normalizeEmptyListItems(nextEditor)
      lastCommittedMarkdownRef.current = content
      // Why: seed the source-preserving reconciliation baseline — the raw loaded
      // bytes and their canonical serialization — so the first edit patches onto
      // the original style instead of re-canonicalizing the whole file.
      originalSourceRef.current = content
      baseCanonicalRef.current = nextEditor.getMarkdown()
      isInitializingRef.current = false
      cancelAutoFocusRef.current?.()
      cancelAutoFocusRef.current = autoFocusRichEditor(nextEditor, rootRef.current)
    },
    onBeforeCreate: ({ editor: nextEditor }) => {
      setRichMarkdownImageResolverContext(
        nextEditor,
        createRichMarkdownImageResolverContext({
          filePath,
          runtimeEnvironmentId,
          settings,
          worktreeId,
          worktreeRoot
        })
      )
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
          const { markdown, didSerialize } = commitRichMarkdownSerialization(
            nextEditor,
            { originalSourceRef, baseCanonicalRef, lastCommittedMarkdownRef },
            reconcileRoundTripRef.current
          )
          if (didSerialize) {
            onContentChangeRef.current(markdown)
          }
        } catch (error) {
          // Why: teardown and reconcile failures are handled above; other failures must stay observable.
          console.error('[editor] rich markdown serialize (debounced) failed', error)
        }
      }, 300)
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      syncSlashMenu(nextEditor, rootRef.current, setSlashMenu)
      syncDocLinkMenu(nextEditor, rootRef.current, setDocLinkMenu)
      syncAnnotationTarget(nextEditor)
      setIsEditingLink(false)
      setLinkBubble(
        getRichMarkdownSelectionLinkBubble(nextEditor, rootRef.current, htmlSuperscriptLinkContext)
      )
    }
  }
}
