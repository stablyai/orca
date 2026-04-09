import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { RichMarkdownSlashMenu } from './RichMarkdownSlashMenu'
import { useAppStore } from '@/store'
import { RichMarkdownToolbar } from './RichMarkdownToolbar'
import { extractIpcErrorMessage, getImageCopyDestination } from './rich-markdown-image-utils'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { slashCommands, syncSlashMenu } from './rich-markdown-commands'
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
import { registerPendingEditorFlush } from './editor-pending-flush'
import { createRichMarkdownKeyHandler } from './rich-markdown-key-handler'

type RichMarkdownEditorProps = {
  fileId: string
  content: string
  filePath: string
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onSave: (content: string) => void
}

const richMarkdownExtensions = createRichMarkdownExtensions({
  includePlaceholder: true
})

export default function RichMarkdownEditor({
  fileId,
  content,
  filePath,
  onContentChange,
  onDirtyStateHint,
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
  const onDirtyStateHintRef = useRef(onDirtyStateHint)
  const onSaveRef = useRef(onSave)
  const handleLocalImagePickRef = useRef<() => void>(() => {})
  const openSearchRef = useRef<() => void>(() => {})
  // Why: ProseMirror keeps the initial handleKeyDown closure, so `editor` stays
  // stuck at the first-render null value unless we read the live instance here.
  const editorRef = useRef<Editor | null>(null)
  const serializeTimerRef = useRef<number | null>(null)
  const [linkBubble, setLinkBubble] = useState<LinkBubbleState | null>(null)
  const [isEditingLink, setIsEditingLink] = useState(false)
  const isEditingLinkRef = useRef(false)

  useEffect(() => {
    onContentChangeRef.current = onContentChange
  }, [onContentChange])
  useEffect(() => {
    onDirtyStateHintRef.current = onDirtyStateHint
  }, [onDirtyStateHint])
  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])
  useEffect(() => {
    isEditingLinkRef.current = isEditingLink
  }, [isEditingLink])

  const flushPendingSerialization = useCallback(() => {
    if (serializeTimerRef.current === null) {
      return
    }
    window.clearTimeout(serializeTimerRef.current)
    serializeTimerRef.current = null
    try {
      const markdown = editorRef.current?.getMarkdown()
      if (markdown !== undefined) {
        lastCommittedMarkdownRef.current = markdown
        onContentChangeRef.current(markdown)
      }
    } catch {
      // Why: save/restart flows should never crash the UI just because the
      // editor was torn down between scheduling and flushing a debounced sync.
    }
  }, [])

  useEffect(() => {
    // Why: autosave/restart paths live outside the editor component tree, so a
    // mounted rich editor must expose a synchronous "flush now" hook to avoid
    // a dirty-without-draft window during the debounce period.
    return registerPendingEditorFlush(fileId, flushPendingSerialization)
  }, [fileId, flushPendingSerialization])

  const editor = useEditor({
    immediatelyRender: false,
    extensions: richMarkdownExtensions,
    content: encodeRawMarkdownHtmlForRichEditor(content),
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'rich-markdown-editor'
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
        handleLocalImagePickRef,
        flushPendingSerialization,
        openSearchRef,
        setIsEditingLink,
        setLinkBubble,
        setSelectedCommandIndex,
        setSlashMenu
      }),
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
      syncSlashMenu(nextEditor, rootRef.current, setSlashMenu)

      // Why: full markdown serialization is debounced for typing performance,
      // but close-confirmation and beforeunload checks still need to know
      // immediately that the document changed. Optimistically mark the tab
      // dirty here, then let the debounced content sync compute the exact
      // saved-vs-draft comparison a moment later.
      onDirtyStateHintRef.current(true)

      // Why: getMarkdown() serializes the entire ProseMirror document tree on
      // every keystroke, which is the dominant typing-speed bottleneck for large
      // files. Debouncing it to 300ms keeps the draft store and autosave pipeline
      // fed without blocking the input path.
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
          // Why: save/restart flows should never crash the UI just because the
          // editor was torn down between scheduling and flushing a debounced sync.
        }
      }, 300)
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

  // Why: when the component unmounts (tab switch, mode change), flush any
  // pending serialization so the autosave controller's draft store has the
  // latest content and the scroll-position cache captures the right state.
  // This must run before useEditor's cleanup destroys the editor instance,
  // so we use useLayoutEffect (synchronous cleanup) instead of useEffect.
  // React runs layout-effect cleanups before effect cleanups, guaranteeing
  // the editor is still alive when we serialize.
  React.useLayoutEffect(() => {
    return flushPendingSerialization
  }, [flushPendingSerialization])

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
  useEffect(() => {
    openSearchRef.current = openSearch
  }, [openSearch])

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
      <RichMarkdownToolbar
        editor={editor}
        onToggleLink={toggleLinkFromToolbar}
        onImagePick={handleLocalImagePick}
      />
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
