import React, { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { List, ListOrdered, Quote } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isMarkdownPreviewFindShortcut } from './markdown-preview-search'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { slashCommands } from './rich-markdown-commands'
import type { SlashCommand } from './rich-markdown-commands'
import { RichMarkdownSearchBar } from './RichMarkdownSearchBar'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'

type RichMarkdownEditorProps = {
  content: string
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
          const markdown = editor?.getMarkdown() ?? lastCommittedMarkdownRef.current
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

        const activeEditor = editor
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
          // Why: ProseMirror keeps this key handler stable for the editor's
          // lifetime, so reading React state directly here can use a stale
          // slash-menu index and execute the wrong command after keyboard
          // navigation. The ref mirrors the latest highlighted item.
          const selectedCommand = currentFilteredSlashCommands[selectedCommandIndexRef.current]
          if (selectedCommand) {
            runSlashCommand(activeEditor, currentSlashMenu, selectedCommand)
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
        <ToolbarButton
          active={editor?.isActive('bold') ?? false}
          label="Bold"
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          B
        </ToolbarButton>
        <ToolbarButton
          active={editor?.isActive('italic') ?? false}
          label="Italic"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          I
        </ToolbarButton>
        <ToolbarButton
          active={editor?.isActive('strike') ?? false}
          label="Strike"
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          S
        </ToolbarButton>
        <ToolbarButton
          active={editor?.isActive('bulletList') ?? false}
          label="Bullet list"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor?.isActive('orderedList') ?? false}
          label="Numbered list"
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor?.isActive('blockquote') ?? false}
          label="Quote"
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          <Quote className="size-3.5" />
        </ToolbarButton>
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
                onClick={() => editor && runSlashCommand(editor, slashMenu, command)}
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

function ToolbarButton({
  active,
  label,
  onClick,
  children
}: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn('rich-markdown-toolbar-button', active && 'is-active')}
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
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

function runSlashCommand(editor: Editor, slashMenu: SlashMenuState, command: SlashCommand): void {
  editor.chain().focus().deleteRange({ from: slashMenu.from, to: slashMenu.to }).run()
  command.run(editor)
}
