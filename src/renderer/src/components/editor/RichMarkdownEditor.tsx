import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { ImageIcon, List, ListOrdered, Quote } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { RichMarkdownToolbarButton } from './RichMarkdownToolbarButton'
import { isMarkdownPreviewFindShortcut } from './markdown-preview-search'
import { extractIpcErrorMessage, getImageCopyDestination } from './rich-markdown-image-utils'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { slashCommands } from './rich-markdown-commands'
import type { SlashCommand } from './rich-markdown-commands'
import { RichMarkdownSearchBar } from './RichMarkdownSearchBar'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'

type RichMarkdownEditorProps = {
  content: string
  filePath: string
  onContentChange: (content: string) => void
  onSave: (content: string) => void
}

type SlashMenuState = {
  query: string
  from: number
  to: number
  left: number
  top: number
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

  useEffect(() => {
    onContentChangeRef.current = onContentChange
  }, [onContentChange])
  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

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
    }
  })

  useEffect(() => {
    editorRef.current = editor ?? null
  }, [editor])
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
      editor.chain().focus().setImage({ src: imageName }).run()
    } catch (err) {
      toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
    }
  }, [editor, filePath])

  useEffect(() => {
    handleLocalImagePickRef.current = handleLocalImagePick
  }, [handleLocalImagePick])
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
    <div ref={rootRef} className="rich-markdown-editor-shell">
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
      <EditorContent editor={editor} className="min-h-0 flex-1 overflow-auto" />
      {slashMenu && filteredSlashCommands.length > 0 ? (
        <div
          className="rich-markdown-slash-menu"
          style={{ left: slashMenu.left, top: slashMenu.top }}
          role="listbox"
          aria-label="Slash commands"
        >
          {filteredSlashCommands.map((command, index) => {
            const Icon = command.icon
            return (
              <button
                key={command.id}
                type="button"
                className={cn(
                  'rich-markdown-slash-item',
                  index === selectedCommandIndex && 'is-active'
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  editor && runSlashCommand(editor, slashMenu, command, handleLocalImagePick)
                }
              >
                <span className="rich-markdown-slash-icon">
                  <Icon className="size-3.5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col items-start">
                  <span className="truncate text-sm font-medium">{command.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {command.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function syncSlashMenu(
  editor: Editor,
  root: HTMLDivElement | null,
  setSlashMenu: React.Dispatch<React.SetStateAction<SlashMenuState | null>>
): void {
  if (!root || editor.view.composing || !editor.isEditable) {
    setSlashMenu(null)
    return
  }

  const { state, view } = editor
  const { selection } = state
  if (!selection.empty) {
    setSlashMenu(null)
    return
  }

  const { $from } = selection
  if (!$from.parent.isTextblock) {
    setSlashMenu(null)
    return
  }

  const blockTextBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0')
  const slashMatch = blockTextBeforeCursor.match(/^\s*\/([a-z0-9-]*)$/i)
  if (!slashMatch) {
    setSlashMenu(null)
    return
  }

  const slashOffset = blockTextBeforeCursor.lastIndexOf('/')
  const start = selection.from - ($from.parentOffset - slashOffset)
  const coords = view.coordsAtPos(selection.from)
  const rect = root.getBoundingClientRect()

  setSlashMenu({
    query: slashMatch[1] ?? '',
    from: start,
    to: selection.from,
    left: coords.left - rect.left,
    top: coords.bottom - rect.top + 8
  })
}

function runSlashCommand(
  editor: Editor,
  slashMenu: SlashMenuState,
  command: SlashCommand,
  onImageCommand?: () => void
): void {
  editor.chain().focus().deleteRange({ from: slashMenu.from, to: slashMenu.to }).run()
  // Why: image insertion cannot rely on window.prompt() in Electron, so this
  // command is rerouted into the editor's local image picker flow.
  if (command.id === 'image' && onImageCommand) {
    onImageCommand()
    return
  }
  command.run(editor)
}
