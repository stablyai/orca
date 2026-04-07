import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { ImageIcon, Link as LinkIcon, List, ListOrdered, Quote } from 'lucide-react'
import { toast } from 'sonner'
import { RichMarkdownSlashMenu } from './RichMarkdownSlashMenu'
import { useAppStore } from '@/store'
import { RichMarkdownToolbarButton } from './RichMarkdownToolbarButton'
import { isMarkdownPreviewFindShortcut } from './markdown-preview-search'
import { extractIpcErrorMessage, getImageCopyDestination } from './rich-markdown-image-utils'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { runSlashCommand, slashCommands, syncSlashMenu } from './rich-markdown-commands'
import type { SlashCommand, SlashMenuState } from './rich-markdown-commands'
import { RichMarkdownSearchBar } from './RichMarkdownSearchBar'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'
import {
  getLinkBubblePosition,
  RichMarkdownLinkBubble,
  type LinkBubbleState
} from './RichMarkdownLinkBubble'
import { useLinkBubble } from './useLinkBubble'
import { useEditorScrollRestore } from './useEditorScrollRestore'

type RichMarkdownEditorProps = {
  content: string
  filePath: string
  onContentChange: (content: string) => void
  onSave: (content: string) => void
}

const richMarkdownExtensions = createRichMarkdownExtensions({
  includePlaceholder: true
})

export default function RichMarkdownEditor({
  content,
  filePath,
  onContentChange,
  onSave
}: RichMarkdownEditorProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const isMac = navigator.userAgent.includes('Mac')
  const lastCommittedMarkdownRef = useRef(content)
  const slashMenuRef = useRef<SlashMenuState | null>(null)
  const filteredSlashCommandsRef = useRef<SlashCommand[]>(slashCommands)
  const selectedCommandIndexRef = useRef(0)
  const onContentChangeRef = useRef(onContentChange)
  const onSaveRef = useRef(onSave)
  const handleLocalImagePickRef = useRef<() => void>(() => {})
  // Why: ProseMirror keeps the initial handleKeyDown closure, so `editor` stays
  // stuck at the first-render null value unless we read the live instance here.
  const editorRef = useRef<Editor | null>(null)
  const [linkBubble, setLinkBubble] = useState<LinkBubbleState | null>(null)
  const [isEditingLink, setIsEditingLink] = useState(false)
  const isEditingLinkRef = useRef(false)

  useEffect(() => {
    onContentChangeRef.current = onContentChange
  }, [onContentChange])
  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])
  useEffect(() => {
    isEditingLinkRef.current = isEditingLink
  }, [isEditingLink])

  const editor = useEditor({
    immediatelyRender: false,
    extensions: richMarkdownExtensions,
    content: encodeRawMarkdownHtmlForRichEditor(content),
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'rich-markdown-editor'
      },
      handleKeyDown: (_view, event) => {
        const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
        if (isMarkdownPreviewFindShortcut(event, isMac)) {
          event.preventDefault()
          openSearch()
          return true
        }
        if (mod && event.key.toLowerCase() === 's') {
          event.preventDefault()
          const markdown = editorRef.current?.getMarkdown() ?? lastCommittedMarkdownRef.current
          onSaveRef.current(markdown)
          return true
        }

        // Strikethrough: Cmd/Ctrl+Shift+X (standard shortcut used by Google
        // Docs, Notion, etc. — supplements Tiptap's built-in Mod+Shift+S).
        if (mod && event.shiftKey && event.key.toLowerCase() === 'x') {
          event.preventDefault()
          editorRef.current?.chain().focus().toggleStrike().run()
          return true
        }

        // Link: Cmd/Ctrl+K — insert or edit a hyperlink.
        if (mod && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          const ed = editorRef.current
          if (!ed) {
            return true
          }

          if (isEditingLinkRef.current) {
            setIsEditingLink(false)
            if (!ed.isActive('link')) {
              setLinkBubble(null)
            }
            ed.commands.focus()
            return true
          }

          const pos = getLinkBubblePosition(ed, rootRef.current)
          if (pos) {
            const href = ed.isActive('link') ? (ed.getAttributes('link').href as string) || '' : ''
            setLinkBubble({ href, ...pos })
            setIsEditingLink(true)
          }
          return true
        }

        // Tab/Shift-Tab: indent/outdent lists, insert spaces in code blocks,
        // and prevent focus from escaping the editor. When the slash menu is
        // open, Tab selects a command instead (handled in the slash-menu block
        // below).
        if (event.key === 'Tab' && !slashMenuRef.current) {
          event.preventDefault()
          const ed = editorRef.current
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
        const currentSlashMenu = slashMenuRef.current
        if (!currentSlashMenu) {
          return false
        }

        const currentFilteredSlashCommands = filteredSlashCommandsRef.current
        if (currentFilteredSlashCommands.length === 0) {
          return false
        }

        // Why: handleKeyDown is frozen from the first render, so this closure
        // must read editorRef to get the live editor instance.
        const activeEditor = editorRef.current
        if (!activeEditor) {
          return false
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSelectedCommandIndex(
            (currentIndex) => (currentIndex + 1) % currentFilteredSlashCommands.length
          )
          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSelectedCommandIndex(
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
          const selectedCommand = currentFilteredSlashCommands[selectedCommandIndexRef.current]
          if (selectedCommand) {
            runSlashCommand(activeEditor, currentSlashMenu, selectedCommand, () =>
              handleLocalImagePickRef.current()
            )
          }
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setSlashMenu(null)
          return true
        }

        return false
      },
      // Why: Cmd/Ctrl+click on a link opens it in the system browser, matching
      // VS Code and other editor conventions. Without the modifier, clicks just
      // position the cursor normally for editing.
      handleClick: (_view, _pos, event) => {
        const ed = editorRef.current
        if (!ed) {
          return false
        }
        const modKey = isMac ? event.metaKey : event.ctrlKey
        if (modKey && ed.isActive('link')) {
          const href = (ed.getAttributes('link').href as string) || ''
          if (href) {
            void window.api.shell.openUrl(href)
            return true
          }
        }
        return false
      }
    },
    onCreate: ({ editor: nextEditor }) => {
      lastCommittedMarkdownRef.current = nextEditor.getMarkdown()
    },
    onUpdate: ({ editor: nextEditor }) => {
      const markdown = nextEditor.getMarkdown()
      lastCommittedMarkdownRef.current = markdown
      onContentChangeRef.current(markdown)
      syncSlashMenu(nextEditor, rootRef.current, setSlashMenu)
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      syncSlashMenu(nextEditor, rootRef.current, setSlashMenu)

      // Sync link bubble: show preview when cursor is on a link, hide otherwise.
      // Any selection change in the editor cancels an in-progress link edit.
      setIsEditingLink(false)
      if (nextEditor.isActive('link')) {
        const attrs = nextEditor.getAttributes('link')
        const pos = getLinkBubblePosition(nextEditor, rootRef.current)
        if (pos) {
          setLinkBubble({ href: (attrs.href as string) || '', ...pos })
        }
      } else {
        setLinkBubble(null)
      }
    }
  })

  useEffect(() => {
    editorRef.current = editor ?? null
  }, [editor])

  useEditorScrollRestore(scrollContainerRef, `${filePath}:rich`, editor)

  // Why: the custom Image extension reads filePath from editor.storage to resolve
  // relative image src values to file:// URLs for display. After updating the
  // stored path we dispatch a no-op transaction so ProseMirror re-renders image
  // nodes with the new resolved src (renderHTML reads storage at render time).
  useEffect(() => {
    if (editor) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(editor.storage as any).image.filePath = filePath
      editor.view.dispatch(editor.state.tr)
    }
  }, [editor, filePath])

  const handleLocalImagePick = useCallback(async () => {
    if (!editor) {
      return
    }
    // Why: the native file picker steals focus from the editor, which can cause
    // ProseMirror to lose track of its selection. We snapshot the cursor position
    // before the async dialog so we can insert the image exactly where the user
    // intended, not at whatever position focus() falls back to afterward.
    const insertPos = editor.state.selection.from
    try {
      const srcPath = await window.api.shell.pickImage()
      if (!srcPath) {
        return
      }
      // Why: copy the image next to the markdown file and insert a relative path
      // so the markdown stays portable and doesn't bloat with base64 data.
      const { imageName, destPath } = await getImageCopyDestination(filePath, srcPath)
      if (srcPath !== destPath) {
        await window.api.shell.copyFile({ srcPath, destPath })
      }
      // Why: insertContentAt places the image at the exact saved position
      // regardless of where focus lands after the native file dialog closes,
      // whereas setTextSelection can be overridden by ProseMirror's focus logic.
      editor
        .chain()
        .focus()
        .insertContentAt(insertPos, { type: 'image', attrs: { src: imageName } })
        .run()
    } catch (err) {
      toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
    }
  }, [editor, filePath])

  useEffect(() => {
    handleLocalImagePickRef.current = handleLocalImagePick
  }, [handleLocalImagePick])

  const {
    handleLinkSave,
    handleLinkRemove,
    handleLinkEditCancel,
    handleLinkOpen,
    toggleLinkFromToolbar
  } = useLinkBubble(editor, rootRef, linkBubble, setLinkBubble, setIsEditingLink)

  const {
    activeMatchIndex,
    closeSearch,
    isSearchOpen,
    matchCount,
    moveToMatch,
    openSearch,
    searchInputRef,
    searchQuery,
    setSearchQuery
  } = useRichMarkdownSearch({
    editor,
    isMac,
    rootRef
  })

  const filteredSlashCommands = useMemo(() => {
    const query = slashMenu?.query.trim().toLowerCase() ?? ''
    if (!query) {
      return slashCommands
    }
    return slashCommands.filter((command) => {
      const haystack = [command.label, ...command.aliases].join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }, [slashMenu?.query])

  useEffect(() => {
    slashMenuRef.current = slashMenu
  }, [slashMenu])
  useEffect(() => {
    filteredSlashCommandsRef.current = filteredSlashCommands
  }, [filteredSlashCommands])
  useEffect(() => {
    selectedCommandIndexRef.current = selectedCommandIndex
  }, [selectedCommandIndex])
  useEffect(() => {
    if (filteredSlashCommands.length === 0) {
      setSelectedCommandIndex(0)
      return
    }

    setSelectedCommandIndex((currentIndex) =>
      Math.min(currentIndex, filteredSlashCommands.length - 1)
    )
  }, [filteredSlashCommands.length])

  useEffect(() => {
    if (!editor) {
      return
    }

    const currentMarkdown = editor.getMarkdown()
    if (currentMarkdown === content) {
      return
    }

    // Why: markdown files on disk remain the source of truth for rich mode in
    // Orca. External file changes, tab replacement, and save-after-reload must
    // overwrite the editor state so the rich view never drifts from repo text.
    editor.commands.setContent(encodeRawMarkdownHtmlForRichEditor(content), {
      contentType: 'markdown'
    })
    lastCommittedMarkdownRef.current = content
    syncSlashMenu(editor, rootRef.current, setSlashMenu)
  }, [content, editor])

  return (
    <div
      ref={rootRef}
      className="rich-markdown-editor-shell"
      style={{ '--editor-font-zoom-level': editorFontZoomLevel } as React.CSSProperties}
    >
      <div className="rich-markdown-editor-toolbar">
        <RichMarkdownToolbarButton
          active={editor?.isActive('bold') ?? false}
          label="Bold"
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          B
        </RichMarkdownToolbarButton>
        <RichMarkdownToolbarButton
          active={editor?.isActive('italic') ?? false}
          label="Italic"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          I
        </RichMarkdownToolbarButton>
        <RichMarkdownToolbarButton
          active={editor?.isActive('strike') ?? false}
          label="Strike"
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          S
        </RichMarkdownToolbarButton>
        <RichMarkdownToolbarButton
          active={editor?.isActive('bulletList') ?? false}
          label="Bullet list"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List className="size-3.5" />
        </RichMarkdownToolbarButton>
        <RichMarkdownToolbarButton
          active={editor?.isActive('orderedList') ?? false}
          label="Numbered list"
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="size-3.5" />
        </RichMarkdownToolbarButton>
        <RichMarkdownToolbarButton
          active={editor?.isActive('blockquote') ?? false}
          label="Quote"
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          <Quote className="size-3.5" />
        </RichMarkdownToolbarButton>
        <RichMarkdownToolbarButton
          active={editor?.isActive('link') ?? false}
          label="Link"
          onClick={toggleLinkFromToolbar}
        >
          <LinkIcon className="size-3.5" />
        </RichMarkdownToolbarButton>
        <RichMarkdownToolbarButton active={false} label="Image" onClick={handleLocalImagePick}>
          <ImageIcon className="size-3.5" />
        </RichMarkdownToolbarButton>
      </div>
      <RichMarkdownSearchBar
        activeMatchIndex={activeMatchIndex}
        isOpen={isSearchOpen}
        matchCount={matchCount}
        onClose={closeSearch}
        onMoveToMatch={moveToMatch}
        onQueryChange={setSearchQuery}
        query={searchQuery}
        searchInputRef={searchInputRef}
      />
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
        <EditorContent editor={editor} />
      </div>
      {linkBubble ? (
        <RichMarkdownLinkBubble
          linkBubble={linkBubble}
          isEditing={isEditingLink}
          onSave={handleLinkSave}
          onRemove={handleLinkRemove}
          onEditStart={() => setIsEditingLink(true)}
          onEditCancel={handleLinkEditCancel}
          onOpen={handleLinkOpen}
        />
      ) : null}
      {slashMenu && filteredSlashCommands.length > 0 ? (
        <RichMarkdownSlashMenu
          editor={editor}
          slashMenu={slashMenu}
          filteredCommands={filteredSlashCommands}
          selectedIndex={selectedCommandIndex}
          onImagePick={handleLocalImagePick}
        />
      ) : null}
    </div>
  )
}
