import type { KeyHandlerContext } from './rich-markdown-key-handler-context'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'

import type { Editor } from '@tiptap/react'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { useAppStore } from '@/store/index'
import { isMarkdownPreviewFindShortcut } from '../../markdown-preview/search/markdown-preview-search'
import { handleRichMarkdownAddReviewNoteShortcut } from '../review/rich-markdown-annotation-shortcut'

import { commitRow } from '../doc-links/rich-markdown-commands'
import { runSlashCommand } from './rich-markdown-slash-commands'

import {
  collapseEmptyListContinuationParagraph,
  commitEmptyOrderedListMarkerAsText,
  convertEmptyNestedOrderedItemToContinuation,
  exitTrailingEmptyOrderedListItem
} from '../lists/rich-markdown-list-continuation'
import { deleteAdjacentEmptyParagraph } from '../schema/rich-markdown-empty-paragraph-delete'
import { handleRichMarkdownTableBackspace } from '../tables/rich-markdown-table-row-delete'
import { handleRichMarkdownTableEnter } from '../tables/rich-markdown-table-enter'
import { handleRichMarkdownTableTab } from '../tables/rich-markdown-table-tab'
import {
  indentRichMarkdownListItem,
  outdentRichMarkdownListItem
} from '../lists/rich-markdown-list-indent'
import {
  indentRichMarkdownCodeBlock,
  outdentRichMarkdownCodeBlock
} from '../code-blocks/rich-markdown-code-block-indent'
import { handleRichMarkdownCitationKey } from '../citations/rich-markdown-citation-keyboard'

import { handleRichMarkdownLinkShortcut } from '../links/rich-markdown-link-shortcut'
import { handleRichMarkdownSaveShortcut } from './rich-markdown-save-shortcut'
import { flushPendingProseMirrorSelection } from '../review/rich-markdown-selection-flush'

function isComposingMarkdownInput(event: KeyboardEvent, editor: Editor | null): boolean {
  return isImeOwnedKeyboardEvent(event) || editor?.view.composing === true
}

export function createRichMarkdownKeyHandler(
  ctx: KeyHandlerContext
): (_view: unknown, event: KeyboardEvent) => boolean {
  return (_view, event) => {
    if (isImeOwnedKeyboardEvent(event)) {
      return false
    }
    // Save must flush pending text even while the editor's composition state lingers.
    if (handleRichMarkdownSaveShortcut(ctx, event)) {
      return true
    }
    if (isComposingMarkdownInput(event, ctx.editorRef.current)) {
      return false
    }
    const mod = ctx.isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if (
      handleRichMarkdownCitationKey({
        editor: ctx.editorRef.current,
        event,
        linkBubbleOwnerId: ctx.linkBubbleOwnerId,
        onOpen: ctx.openSelectedHtmlSuperscriptLink
      })
    ) {
      return true
    }
    if (
      isMarkdownPreviewFindShortcut(
        event,
        getShortcutPlatform(),
        useAppStore.getState().keybindings
      )
    ) {
      event.preventDefault()
      ctx.openSearchRef.current()
      return true
    }
    if (handleRichMarkdownAddReviewNoteShortcut(ctx, event)) {
      return true
    }

    // Offer the familiar Mod+Shift+X alternative to Tiptap’s Mod+Shift+S.
    if (mod && event.shiftKey && event.key.toLowerCase() === 'x') {
      event.preventDefault()
      ctx.editorRef.current?.chain().focus().toggleStrike().run()
      return true
    }

    if (
      handleRichMarkdownLinkShortcut({
        editor: ctx.editorRef.current,
        event,
        htmlSuperscriptLinkContext: ctx.htmlSuperscriptLinkContext,
        isEditing: ctx.isEditingLinkRef.current,
        isMac: ctx.isMac,
        root: ctx.rootRef.current,
        setEditing: ctx.setIsEditingLink,
        setLinkBubble: ctx.setLinkBubble
      })
    ) {
      return true
    }

    if (event.key === 'Backspace') {
      const ed = ctx.editorRef.current
      if (
        ed &&
        !isComposingMarkdownInput(event, ed) &&
        (convertEmptyNestedOrderedItemToContinuation(ed) ||
          collapseEmptyListContinuationParagraph(ed) ||
          deleteAdjacentEmptyParagraph(ed, 'backward') ||
          handleRichMarkdownTableBackspace(ed))
      ) {
        event.preventDefault()
        return true
      }
    }

    if (event.key === 'Delete') {
      const ed = ctx.editorRef.current
      if (
        ed &&
        !isComposingMarkdownInput(event, ed) &&
        deleteAdjacentEmptyParagraph(ed, 'forward')
      ) {
        event.preventDefault()
        return true
      }
    }

    if (event.key === 'Enter') {
      const ed = ctx.editorRef.current
      if (
        ed &&
        !isComposingMarkdownInput(event, ed) &&
        ctx.typedEmptyOrderedListMarkerRef.current &&
        commitEmptyOrderedListMarkerAsText(ed)
      ) {
        ctx.typedEmptyOrderedListMarkerRef.current = false
        event.preventDefault()
        return true
      }
      if (ed && !isComposingMarkdownInput(event, ed) && exitTrailingEmptyOrderedListItem(ed)) {
        event.preventDefault()
        return true
      }
      // Table Enter must precede unserializable in-cell paragraph insertion; open menus retain Enter ownership.
      if (
        ed &&
        !ctx.slashMenuRef.current &&
        !ctx.docLinkMenuRef.current &&
        !isComposingMarkdownInput(event, ed) &&
        handleRichMarkdownTableEnter(ed, event, mod)
      ) {
        event.preventDefault()
        return true
      }
    }

    // Menus own Tab while open; otherwise navigate table cells before list/code indentation and prevent focus escape.
    if (event.key === 'Tab' && !ctx.slashMenuRef.current && !ctx.docLinkMenuRef.current) {
      event.preventDefault()
      const ed = ctx.editorRef.current
      if (!ed) {
        return true
      }
      flushPendingProseMirrorSelection(ed)

      // Run table navigation before list indentation because this handler precedes Tiptap’s table shortcuts.
      if (!isComposingMarkdownInput(event, ed) && handleRichMarkdownTableTab(ed, event.shiftKey)) {
        return true
      }

      if (event.shiftKey) {
        if (!outdentRichMarkdownCodeBlock(ed)) {
          outdentRichMarkdownListItem(ed)
        }
        return true
      }

      if (ed.isActive('codeBlock')) {
        indentRichMarkdownCodeBlock(ed)
        return true
      }

      // Consume Tab even when list indentation no-ops, preventing focus escape.
      indentRichMarkdownListItem(ed)
      return true
    }

    // Handle document links before the slash-menu early return or their menu becomes unreachable.
    const currentDocLinkMenu = ctx.docLinkMenuRef.current
    if (currentDocLinkMenu) {
      const currentFilteredDocLinkRows = ctx.filteredDocLinkRowsRef.current
      const activeEditorForDocLink = ctx.editorRef.current

      if (event.key === 'ArrowDown') {
        if (currentFilteredDocLinkRows.length === 0) {
          return false
        }
        event.preventDefault()
        ctx.setSelectedDocLinkIndex(
          (currentIndex) => (currentIndex + 1) % currentFilteredDocLinkRows.length
        )
        return true
      }
      if (event.key === 'ArrowUp') {
        if (currentFilteredDocLinkRows.length === 0) {
          return false
        }
        event.preventDefault()
        ctx.setSelectedDocLinkIndex(
          (currentIndex) =>
            (currentIndex - 1 + currentFilteredDocLinkRows.length) %
            currentFilteredDocLinkRows.length
        )
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        // With no rows, let Enter create a paragraph; the next sync closes the menu.
        if (currentFilteredDocLinkRows.length === 0 || !activeEditorForDocLink) {
          return false
        }
        event.preventDefault()
        const selectedRow =
          currentFilteredDocLinkRows[ctx.selectedDocLinkIndexRef.current] ??
          currentFilteredDocLinkRows[0]
        if (selectedRow) {
          commitRow(activeEditorForDocLink, currentDocLinkMenu, selectedRow)
        }
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        ctx.setDocLinkMenu(null)
        return true
      }
      // Other keys fall through; selection/content updates resync the trigger and popover.
    }

    const currentSlashMenu = ctx.slashMenuRef.current
    if (!currentSlashMenu) {
      return false
    }

    const currentFilteredSlashCommands = ctx.filteredSlashCommandsRef.current

    if (event.key === 'Escape') {
      event.preventDefault()
      ctx.setSlashMenu(null)
      return true
    }

    if (currentFilteredSlashCommands.length === 0) {
      return false
    }

    // The lifetime-stable handler must read the current editor from its ref.
    const activeEditor = ctx.editorRef.current
    if (!activeEditor) {
      return false
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      ctx.setSelectedCommandIndex(
        (currentIndex) => (currentIndex + 1) % currentFilteredSlashCommands.length
      )
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      ctx.setSelectedCommandIndex(
        (currentIndex) =>
          (currentIndex - 1 + currentFilteredSlashCommands.length) %
          currentFilteredSlashCommands.length
      )
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      // Read the latest highlighted command through its ref, avoiding the initial render’s stale selection.
      const selectedCommand = currentFilteredSlashCommands[ctx.selectedCommandIndexRef.current]
      if (selectedCommand) {
        runSlashCommand(
          activeEditor,
          currentSlashMenu,
          selectedCommand,
          () => ctx.handleLocalImagePickRef.current(),
          () => ctx.handleEmojiPickRef.current(currentSlashMenu)
        )
      }
      return true
    }
    return false
  }
}
