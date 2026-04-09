import type { MutableRefObject, Dispatch, SetStateAction } from 'react'
import type { Editor } from '@tiptap/react'
import { isMarkdownPreviewFindShortcut } from './markdown-preview-search'
import { getLinkBubblePosition, type LinkBubbleState } from './RichMarkdownLinkBubble'
import { runSlashCommand, type SlashCommand, type SlashMenuState } from './rich-markdown-commands'

export type KeyHandlerContext = {
  isMac: boolean
  editorRef: MutableRefObject<Editor | null>
  rootRef: MutableRefObject<HTMLDivElement | null>
  lastCommittedMarkdownRef: MutableRefObject<string>
  onContentChangeRef: MutableRefObject<(content: string) => void>
  onSaveRef: MutableRefObject<(content: string) => void>
  isEditingLinkRef: MutableRefObject<boolean>
  slashMenuRef: MutableRefObject<SlashMenuState | null>
  filteredSlashCommandsRef: MutableRefObject<SlashCommand[]>
  selectedCommandIndexRef: MutableRefObject<number>
  handleLocalImagePickRef: MutableRefObject<() => void>
  flushPendingSerialization: () => void
  openSearchRef: MutableRefObject<() => void>
  setIsEditingLink: (editing: boolean) => void
  setLinkBubble: (bubble: LinkBubbleState | null) => void
  setSelectedCommandIndex: Dispatch<SetStateAction<number>>
  setSlashMenu: (menu: SlashMenuState | null) => void
}

/**
 * Why: extracted from RichMarkdownEditor to stay under the file line-limit
 * while keeping the keyboard handler logic co-located and testable.
 */
export function createRichMarkdownKeyHandler(
  ctx: KeyHandlerContext
): (_view: unknown, event: KeyboardEvent) => boolean {
  return (_view, event) => {
    const mod = ctx.isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if (isMarkdownPreviewFindShortcut(event, ctx.isMac)) {
      event.preventDefault()
      ctx.openSearchRef.current()
      return true
    }
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault()
      // Why: flush any pending debounced serialization so the save
      // captures the very latest editor content, not a stale snapshot.
      ctx.flushPendingSerialization()
      const markdown = ctx.editorRef.current?.getMarkdown() ?? ctx.lastCommittedMarkdownRef.current
      ctx.lastCommittedMarkdownRef.current = markdown
      ctx.onContentChangeRef.current(markdown)
      ctx.onSaveRef.current(markdown)
      return true
    }

    // Strikethrough: Cmd/Ctrl+Shift+X (standard shortcut used by Google
    // Docs, Notion, etc. — supplements Tiptap's built-in Mod+Shift+S).
    if (mod && event.shiftKey && event.key.toLowerCase() === 'x') {
      event.preventDefault()
      ctx.editorRef.current?.chain().focus().toggleStrike().run()
      return true
    }

    // Link: Cmd/Ctrl+K — insert or edit a hyperlink.
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      const ed = ctx.editorRef.current
      if (!ed) {
        return true
      }

      if (ctx.isEditingLinkRef.current) {
        ctx.setIsEditingLink(false)
        if (!ed.isActive('link')) {
          ctx.setLinkBubble(null)
        }
        ed.commands.focus()
        return true
      }

      const pos = getLinkBubblePosition(ed, ctx.rootRef.current)
      if (pos) {
        const href = ed.isActive('link') ? (ed.getAttributes('link').href as string) || '' : ''
        ctx.setLinkBubble({ href, ...pos })
        ctx.setIsEditingLink(true)
      }
      return true
    }

    // Tab/Shift-Tab: indent/outdent lists, insert spaces in code blocks,
    // and prevent focus from escaping the editor. When the slash menu is
    // open, Tab selects a command instead (handled in the slash-menu block
    // below).
    if (event.key === 'Tab' && !ctx.slashMenuRef.current) {
      event.preventDefault()
      const ed = ctx.editorRef.current
      if (!ed) {
        return true
      }

      if (event.shiftKey) {
        if (!ed.commands.liftListItem('listItem')) {
          ed.commands.liftListItem('taskItem')
        }
        return true
      }

      if (ed.isActive('codeBlock')) {
        ed.commands.insertContent('  ')
        return true
      }

      // Why: sinkListItem succeeds when cursor is in a non-first list item;
      // otherwise it no-ops. Either way we consume Tab to prevent focus escape.
      if (!ed.commands.sinkListItem('listItem')) {
        ed.commands.sinkListItem('taskItem')
      }
      return true
    }

    // ── Slash menu navigation ─────────────────────────
    const currentSlashMenu = ctx.slashMenuRef.current
    if (!currentSlashMenu) {
      return false
    }

    const currentFilteredSlashCommands = ctx.filteredSlashCommandsRef.current
    if (currentFilteredSlashCommands.length === 0) {
      return false
    }

    // Why: handleKeyDown is frozen from the first render, so this closure
    // must read editorRef to get the live editor instance.
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
      // Why: this key handler is stable for the editor lifetime, so the ref
      // mirrors the latest highlighted slash-menu item for keyboard picks.
      const selectedCommand = currentFilteredSlashCommands[ctx.selectedCommandIndexRef.current]
      if (selectedCommand) {
        runSlashCommand(activeEditor, currentSlashMenu, selectedCommand, () =>
          ctx.handleLocalImagePickRef.current()
        )
      }
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      ctx.setSlashMenu(null)
      return true
    }

    return false
  }
}
