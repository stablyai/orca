/* eslint-disable max-lines -- Why: this component co-locates the rich markdown editor surface, toolbar, search, and slash menu so tightly coupled editor state stays in one place. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import type { MarkdownDocument } from '../../../../shared/types'
import { RichMarkdownSlashMenu } from './RichMarkdownSlashMenu'
import { RichMarkdownDocLinkMenu } from './RichMarkdownDocLinkMenu'
import { useAppStore } from '@/store'
import { RichMarkdownToolbar } from './RichMarkdownToolbar'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { useLocalImagePick } from './useLocalImagePick'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { slashCommands, syncDocLinkMenu, syncSlashMenu } from './rich-markdown-commands'
import type {
  DocLinkMenuRow,
  DocLinkMenuState,
  SlashCommand,
  SlashMenuState
} from './rich-markdown-commands'
import { getMarkdownDocCompletionDocuments } from './markdown-doc-completions'
import { RichMarkdownSearchBar } from './RichMarkdownSearchBar'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'
import {
  getLinkBubblePosition,
  RichMarkdownLinkBubble,
  type LinkBubbleState
} from './RichMarkdownLinkBubble'
import { useLinkBubble } from './useLinkBubble'
import { useEditorScrollRestore } from './useEditorScrollRestore'
import { useModifierHeldClass } from './useModifierHeldClass'
import { registerPendingEditorFlush } from './editor-pending-flush'
import { createRichMarkdownKeyHandler } from './rich-markdown-key-handler'
import { normalizeSoftBreaks } from './rich-markdown-normalize'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'
import { handleRichMarkdownCut } from './rich-markdown-cut-handler'
import { openHttpLink } from '@/lib/http-link-routing'
import { toast } from 'sonner'
import { isSingleEmptyTopLevelOrderedList } from './rich-markdown-list-continuation'
import {
  absolutePathToFileUri as toFileUrlForOsEscape,
  resolveMarkdownLinkTarget
} from './markdown-internal-links'
import { scrollToAnchorInEditor } from './markdown-anchor-scroll'
import type {
  RichMarkdownContextMenuCommand,
  RichMarkdownContextMenuCommandPayload
} from '../../../../shared/rich-markdown-context-menu'
import { buildMarkdownTableOfContents, type MarkdownTocItem } from './markdown-table-of-contents'
import { MarkdownTableOfContentsPanel } from './MarkdownTableOfContentsPanel'

type RichMarkdownEditorProps = {
  fileId: string
  content: string
  filePath: string
  worktreeId: string
  scrollCacheKey: string
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onSave: (content: string) => void
  onOpenDocLink?: (target: string) => void
  markdownDocuments?: MarkdownDocument[]
  showTableOfContents?: boolean
  onCloseTableOfContents?: () => void
  // Why: front-matter is stripped from the rich editor's content but we still
  // want it visible to the user. It renders between the toolbar and the editor
  // surface so the formatting toolbar stays at the top of the pane.
  headerSlot?: React.ReactNode
}

const richMarkdownExtensions = createRichMarkdownExtensions({
  includePlaceholder: true
})

function runRichMarkdownContextCommand(
  command: RichMarkdownContextMenuCommand,
  editor: Editor,
  toggleLink: () => void,
  pickImage: () => void
): void {
  switch (command) {
    case 'add-link':
      toggleLink()
      return
    case 'bold':
      editor.chain().focus().toggleBold().run()
      return
    case 'italic':
      editor.chain().focus().toggleItalic().run()
      return
    case 'strike':
      editor.chain().focus().toggleStrike().run()
      return
    case 'inline-code':
      editor.chain().focus().toggleCode().run()
      return
    case 'code-block':
      editor.chain().focus().toggleCodeBlock().run()
      return
    case 'blockquote':
      editor.chain().focus().toggleBlockquote().run()
      return
    case 'paragraph':
      editor.chain().focus().setParagraph().run()
      return
    case 'heading-1':
      editor.chain().focus().setHeading({ level: 1 }).run()
      return
    case 'heading-2':
      editor.chain().focus().setHeading({ level: 2 }).run()
      return
    case 'heading-3':
      editor.chain().focus().setHeading({ level: 3 }).run()
      return
    case 'bullet-list':
      editor.chain().focus().toggleBulletList().run()
      return
    case 'ordered-list':
      editor.chain().focus().toggleOrderedList().run()
      return
    case 'task-list':
      editor.chain().focus().toggleTaskList().run()
      return
    case 'image':
      pickImage()
      return
    case 'divider':
      editor.chain().focus().setHorizontalRule().run()
  }
}

function shouldFocusEmptyEditorFromSurfaceClick(
  event: React.MouseEvent<HTMLDivElement>,
  editor: Editor | null
): boolean {
  if (!editor?.isEmpty || event.button !== 0) {
    return false
  }
  const target = event.target
  if (!(target instanceof Element)) {
    return false
  }
  return !target.closest('.rich-markdown-editor-shell button, .rich-markdown-editor-shell input')
}

function isRichMarkdownContextCommandTarget(
  payload: RichMarkdownContextMenuCommandPayload,
  root: HTMLElement | null
): boolean {
  if (!root) {
    return false
  }
  const rect = root.getBoundingClientRect()
  return (
    payload.x >= rect.left &&
    payload.x <= rect.right &&
    payload.y >= rect.top &&
    payload.y <= rect.bottom
  )
}

function flattenMarkdownTocItems(items: MarkdownTocItem[]): MarkdownTocItem[] {
  return items.flatMap((item) => [item, ...flattenMarkdownTocItems(item.children)])
}

export default function RichMarkdownEditor({
  fileId,
  content,
  filePath,
  worktreeId,
  scrollCacheKey,
  onContentChange,
  onDirtyStateHint,
  onSave,
  onOpenDocLink,
  markdownDocuments,
  showTableOfContents = false,
  onCloseTableOfContents,
  headerSlot
}: RichMarkdownEditorProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const activateMarkdownLink = useAppStore((s) => s.activateMarkdownLink)
  const worktreeRoot = useAppStore((s) => {
    for (const list of Object.values(s.worktreesByRepo)) {
      const wt = list.find((w) => w.id === worktreeId)
      if (wt) {
        return wt.path
      }
    }
    return null
  })
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const [docLinkMenu, setDocLinkMenu] = useState<DocLinkMenuState | null>(null)
  const [selectedDocLinkIndex, setSelectedDocLinkIndex] = useState(0)
  const isMac = navigator.userAgent.includes('Mac')
  const lastCommittedMarkdownRef = useRef(content)
  const slashMenuRef = useRef<SlashMenuState | null>(null)
  const filteredSlashCommandsRef = useRef<SlashCommand[]>(slashCommands)
  const selectedCommandIndexRef = useRef(0)
  const docLinkMenuRef = useRef<DocLinkMenuState | null>(null)
  const filteredDocLinkRowsRef = useRef<DocLinkMenuRow[]>([])
  const selectedDocLinkIndexRef = useRef(0)
  const onContentChangeRef = useRef(onContentChange)
  const onDirtyStateHintRef = useRef(onDirtyStateHint)
  const onSaveRef = useRef(onSave)
  const onOpenDocLinkRef = useRef(onOpenDocLink)
  const handleLocalImagePickRef = useRef<() => void>(() => {})
  const openSearchRef = useRef<() => void>(() => {})
  // Why: ProseMirror keeps the initial handleKeyDown closure, so `editor` stays
  // stuck at the first-render null value unless we read the live instance here.
  const editorRef = useRef<Editor | null>(null)
  const serializeTimerRef = useRef<number | null>(null)
  // Why: normalizeSoftBreaks dispatches a ProseMirror transaction inside onCreate
  // which triggers onUpdate. Without this guard the editor immediately marks the
  // file dirty before the user has typed anything.
  const isInitializingRef = useRef(true)
  // Why: internal maintenance paths can dispatch transactions after mount
  // (external reloads, soft-break normalization, image-path refresh). Those
  // are not user edits, so onUpdate must ignore them or split panes can flip a
  // shared file dirty without any real content change.
  const isApplyingProgrammaticUpdateRef = useRef(false)
  const [linkBubble, setLinkBubble] = useState<LinkBubbleState | null>(null)
  const [isEditingLink, setIsEditingLink] = useState(false)
  const isEditingLinkRef = useRef(false)
  const typedEmptyOrderedListMarkerRef = useRef(false)
  const tableOfContentsItems = useMemo(() => buildMarkdownTableOfContents(content), [content])
  const flatTableOfContentsItems = useMemo(
    () => flattenMarkdownTocItems(tableOfContentsItems),
    [tableOfContentsItems]
  )

  // Why: assigning callback refs during render keeps them current before any
  // ProseMirror handler reads them, avoiding the one-render stale window that
  // useEffect would introduce. Refs are mutable and never trigger re-renders.
  onContentChangeRef.current = onContentChange
  onDirtyStateHintRef.current = onDirtyStateHint
  onSaveRef.current = onSave
  onOpenDocLinkRef.current = onOpenDocLink
  isEditingLinkRef.current = isEditingLink

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
        class: 'rich-markdown-editor',
        spellcheck: 'true'
      },
      handleDOMEvents: {
        cut: handleRichMarkdownCut
      },
      handleTextInput: (view, from, to, text) => {
        typedEmptyOrderedListMarkerRef.current = false
        if (text !== ' ' || from !== to || !view.state.selection.empty) {
          return false
        }
        const { $from } = view.state.selection
        const beforeCursor = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0')
        // Why: only a typed ordered-list shortcut should preserve `1.` on
        // Enter; toolbar/slash/context-created empty lists should exit normally.
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
      // Why: Cmd/Ctrl-click activates links via the shared classifier +
      // dispatcher, so in-worktree .md links open in an Orca tab instead of the
      // OS default handler. Cmd/Ctrl+Shift-click is the OS escape hatch, kept
      // symmetric with MarkdownPreview. Without a modifier the click falls
      // through to TipTap's default cursor-positioning behavior.
      // Why: ProseMirror fires handleClick before updating the selection, so
      // ed.isActive('link') reads the *old* cursor position. We resolve the
      // link mark directly at the clicked pos instead.
      handleClick: (view, pos, event) => {
        const ed = editorRef.current
        const modKey = isMac ? event.metaKey : event.ctrlKey
        if (!ed || !modKey) {
          return false
        }
        // Why: doc links are atom nodes (not marks), so resolve(pos).marks()
        // won't find them. Check nodeAt(pos) first for doc link navigation.
        const clickedNode = view.state.doc.nodeAt(pos)
        if (clickedNode?.type.name === 'image') {
          const src = (clickedNode.attrs.src as string | undefined) ?? ''
          if (!src) {
            return false
          }
          void activateMarkdownLink(src, { sourceFilePath: filePath, worktreeId, worktreeRoot })
          return true
        }
        if (clickedNode?.type.name === 'markdownDocLink') {
          const target = clickedNode.attrs.target as string
          if (target && onOpenDocLinkRef.current) {
            onOpenDocLinkRef.current(target)
          }
          return true
        }
        const linkMark = view.state.doc
          .resolve(pos)
          .marks()
          .find((m) => m.type.name === 'link')
        const href = linkMark ? (linkMark.attrs.href as string) || '' : ''
        if (!href) {
          return false
        }
        if (href.startsWith('#')) {
          scrollToAnchorInEditor(rootRef.current, href.slice(1))
          return true
        }
        if (event.shiftKey) {
          const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
          if (!classified) {
            return true
          }
          if (classified.kind === 'external') {
            openHttpLink(classified.url, { forceSystemBrowser: true })
          } else if (classified.kind === 'markdown') {
            void window.api.shell.pathExists(classified.absolutePath).then((exists) => {
              if (!exists) {
                toast.error(`File not found: ${classified.relativePath}`)
                return
              }
              void window.api.shell.openFileUri(toFileUrlForOsEscape(classified.absolutePath))
            })
          } else if (classified.kind === 'file') {
            void window.api.shell.openFileUri(classified.uri)
          }
          return true
        }
        void activateMarkdownLink(href, { sourceFilePath: filePath, worktreeId, worktreeRoot })
        return true
      }
    },
    onFocus: () => {
      // Why: mirror TipTap focus into the main process so the before-input-event
      // Cmd+B carve-out in createMainWindow.ts lets the bold keymap run instead
      // of intercepting the chord for sidebar toggle.
      // See docs/markdown-cmd-b-bold-design.md.
      window.api.ui.setMarkdownEditorFocused(true)
    },
    onBlur: () => {
      window.api.ui.setMarkdownEditorFocused(false)
    },
    onCreate: ({ editor: nextEditor }) => {
      // Why: markdown soft line breaks produce paragraphs with embedded `\n` chars.
      // Normalizing them into separate paragraph nodes on load ensures Cmd+X (and
      // other block-level operations) treat each line as its own block.
      normalizeSoftBreaks(nextEditor)
      // Why: raw disk content is the source of truth for dirty/external-change
      // detection. getMarkdown() may round-trip soft breaks or trailing newlines
      // differently, which would otherwise force a spurious mount-time re-sync.
      lastCommittedMarkdownRef.current = content
      // Why: clear the flag *after* normalizeSoftBreaks so any onUpdate
      // triggered by the normalization transaction is still suppressed.
      isInitializingRef.current = false
      // Why: MonacoEditor already auto-focuses on mount so users can start
      // typing immediately. The rich markdown editor must do the same,
      // otherwise opening a new markdown file (Cmd+Shift+N) or switching to
      // an existing markdown tab leaves the cursor outside the editing
      // surface and the user has to click before typing.
      autoFocusRichEditor(nextEditor, rootRef.current)
    },
    onUpdate: ({ editor: nextEditor }) => {
      syncSlashMenu(nextEditor, rootRef.current, setSlashMenu)
      syncDocLinkMenu(nextEditor, rootRef.current, setDocLinkMenu)
      if (!isSingleEmptyTopLevelOrderedList(nextEditor)) {
        typedEmptyOrderedListMarkerRef.current = false
      }

      // Why: bail out during normalizeSoftBreaks's onCreate transaction so the
      // structural housekeeping doesn't mark the file dirty before the user
      // has typed anything.
      if (isInitializingRef.current || isApplyingProgrammaticUpdateRef.current) {
        return
      }

      // Why: optimistically mark dirty for close-confirmation before the
      // debounced content sync computes the exact saved-vs-draft comparison.
      onDirtyStateHintRef.current(true)

      // Why: getMarkdown() is the typing-speed bottleneck for large files;
      // debouncing to 300ms keeps drafts current without blocking input.
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
      syncDocLinkMenu(nextEditor, rootRef.current, setDocLinkMenu)

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

  // Why: TipTap's onBlur may not fire on unmount paths (tab close, HMR,
  // component teardown while focused), leaving the main-process flag stale at
  // `true` and silently disabling Cmd+B sidebar-toggle until the next editor
  // focus/blur cycle. Force a `false` on unmount as a belt-and-braces reset.
  // See docs/markdown-cmd-b-bold-design.md "Stale-flag recovery".
  useEffect(() => {
    return () => {
      window.api.ui.setMarkdownEditorFocused(false)
    }
  }, [])

  // Why: use useLayoutEffect (synchronous cleanup) so the pending serialization
  // flush runs before useEditor's cleanup destroys the editor instance on tab
  // switch or mode change. React runs layout-effect cleanups before effect
  // cleanups, guaranteeing the editor is still alive when we serialize.
  React.useLayoutEffect(() => {
    return flushPendingSerialization
  }, [flushPendingSerialization])

  useEditorScrollRestore(scrollContainerRef, scrollCacheKey, editor)

  useModifierHeldClass(rootRef, isMac)

  // Why: the custom Image extension reads filePath from editor.storage to resolve
  // relative image src values to file:// URLs for display. After updating the
  // stored path we dispatch a no-op transaction so ProseMirror re-renders image
  // nodes with the new resolved src (renderHTML reads storage at render time).
  useEffect(() => {
    if (editor) {
      isApplyingProgrammaticUpdateRef.current = true
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(editor.storage as any).image.filePath = filePath
        editor.view.dispatch(editor.state.tr)
      } finally {
        isApplyingProgrammaticUpdateRef.current = false
      }
    }
  }, [editor, filePath])

  // Why: the doc link NodeView reads the document list from storage to style
  // resolved vs. missing links. The no-op transaction with meta flag triggers
  // both nodeView `update` callbacks and the decoration plugin rebuild.
  useEffect(() => {
    if (editor && markdownDocuments) {
      isApplyingProgrammaticUpdateRef.current = true
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(editor.storage as any).markdownDocLink.documents = markdownDocuments
        const tr = editor.state.tr.setMeta('docLinksUpdated', true)
        editor.view.dispatch(tr)
      } finally {
        isApplyingProgrammaticUpdateRef.current = false
      }
    }
  }, [editor, markdownDocuments])

  const handleLocalImagePick = useLocalImagePick(editor, filePath)

  useEffect(() => {
    handleLocalImagePickRef.current = handleLocalImagePick
  }, [handleLocalImagePick])

  const {
    handleLinkSave,
    handleLinkRemove,
    handleLinkEditCancel,
    handleLinkOpen,
    toggleLinkFromToolbar
  } = useLinkBubble(editor, rootRef, linkBubble, setLinkBubble, setIsEditingLink, {
    sourceFilePath: filePath,
    worktreeId,
    worktreeRoot
  })

  useEffect(() => {
    return window.api.ui.onRichMarkdownContextCommand((payload) => {
      const ed = editorRef.current
      if (!ed || !isRichMarkdownContextCommandTarget(payload, rootRef.current)) {
        return
      }

      runRichMarkdownContextCommand(
        payload.command,
        ed,
        toggleLinkFromToolbar,
        handleLocalImagePick
      )
    })
  }, [handleLocalImagePick, toggleLinkFromToolbar])

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
    rootRef,
    scrollContainerRef
  })
  useEffect(() => {
    openSearchRef.current = openSearch
  }, [openSearch])

  const navigateToTableOfContentsItem = useCallback(
    (id: string): void => {
      const target = flatTableOfContentsItems.find((item) => item.id === id)
      const container = scrollContainerRef.current
      if (!target || !container) {
        return
      }
      const sameTitleIndex = flatTableOfContentsItems
        .filter((item) => item.title === target.title)
        .findIndex((item) => item.id === target.id)
      const matchingHeadings = Array.from(
        container.querySelectorAll<HTMLElement>('h1, h2, h3')
      ).filter((candidate) => candidate.textContent?.trim() === target.title)
      const heading = matchingHeadings.at(Math.max(0, sameTitleIndex))
      heading?.scrollIntoView({ block: 'center' })
    },
    [flatTableOfContentsItems]
  )

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

  // Why: memo key is the `markdownDocuments` prop (stable reference from parent),
  // not `editor.storage.markdownDocLink.documents`. The storage mirror is mutated
  // in place by the extension so React would not see a new reference and the memo
  // would stale-out. The prop is the single source of truth for filtering.
  const DOC_LINK_MENU_MAX_ROWS = 20
  const { docLinkRows, docLinkTotalMatches } = useMemo(() => {
    if (!docLinkMenu || !markdownDocuments) {
      return { docLinkRows: [] as DocLinkMenuRow[], docLinkTotalMatches: 0 }
    }
    const matches = getMarkdownDocCompletionDocuments(markdownDocuments, docLinkMenu.query)
    const rows: DocLinkMenuRow[] = matches
      .slice(0, DOC_LINK_MENU_MAX_ROWS)
      .map((document) => ({ kind: 'document', document }))
    return { docLinkRows: rows, docLinkTotalMatches: matches.length }
  }, [docLinkMenu, markdownDocuments])

  useEffect(() => {
    docLinkMenuRef.current = docLinkMenu
  }, [docLinkMenu])
  useEffect(() => {
    filteredDocLinkRowsRef.current = docLinkRows
  }, [docLinkRows])
  useEffect(() => {
    selectedDocLinkIndexRef.current = selectedDocLinkIndex
  }, [selectedDocLinkIndex])
  useEffect(() => {
    if (docLinkRows.length === 0) {
      setSelectedDocLinkIndex(0)
      return
    }
    setSelectedDocLinkIndex((currentIndex) => Math.min(currentIndex, docLinkRows.length - 1))
  }, [docLinkRows.length])

  useEffect(() => {
    if (!editor) {
      return
    }

    // Why: the debounced onUpdate serializes the editor and feeds it back
    // through onContentChange → editorDrafts → the content prop.  If the
    // user typed between the debounce firing and this effect running, the
    // editor already contains newer content than the prop.  Comparing
    // against lastCommittedMarkdownRef (which is set in the same tick as
    // onContentChange) lets us recognise our own serialization and skip the
    // destructive setContent that would reset the cursor mid-typing.
    if (content === lastCommittedMarkdownRef.current) {
      return
    }

    const currentMarkdown = editor.getMarkdown()
    if (currentMarkdown === content) {
      return
    }

    // Why: markdown files on disk remain the source of truth for rich mode in
    // Orca. External file changes, tab replacement, and save-after-reload must
    // overwrite the editor state so the rich view never drifts from repo text.
    isApplyingProgrammaticUpdateRef.current = true
    try {
      // Why: swallow exceptions from setContent / normalizeSoftBreaks here
      // rather than letting them escape to the React root. Under split-pane
      // external reload (two RichMarkdownEditor instances receiving the same
      // Claude Code write), a throw from the TipTap/ProseMirror transaction
      // would otherwise unmount the entire renderer and black the whole
      // window out (issue #826). The committed-markdown ref is deliberately
      // left pointing at the pre-failure value so the next prop change still
      // triggers a re-sync attempt instead of being short-circuited by the
      // `content === lastCommittedMarkdownRef.current` guard above.
      try {
        // Why: TipTap's setContent collapses the selection to the end of the
        // new document by default. When the editor is focused (user is
        // actively typing), that reads as a spontaneous cursor jump to EOF.
        // Snapshot the current selection bounds and restore them clamped to
        // the new doc length after the content swap so the caret stays put
        // for any genuinely external edit that lands during a typing session.
        // The old doc's offsets are a best-effort heuristic — for a real
        // external rewrite they won't map to the semantically equivalent
        // position, but this is still strictly better than jumping to EOF.
        const hadFocus = editor.isFocused
        const { from: prevFrom, to: prevTo } = editor.state.selection
        editor.commands.setContent(encodeRawMarkdownHtmlForRichEditor(content), {
          contentType: 'markdown',
          emitUpdate: false
        })
        // Why: same soft-break normalization as onCreate — external content updates
        // may re-introduce paragraphs with embedded `\n` characters.
        normalizeSoftBreaks(editor)
        lastCommittedMarkdownRef.current = content
        if (hadFocus) {
          // Why: setContent can blur the editor via ProseMirror's focus
          // handling, so restoring selection alone would leave subsequent
          // keystrokes going to the browser. Chain focus() after the
          // selection restore to keep the typing session intact.
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
    } finally {
      isApplyingProgrammaticUpdateRef.current = false
    }
    syncSlashMenu(editor, rootRef.current, setSlashMenu)
    syncDocLinkMenu(editor, rootRef.current, setDocLinkMenu)
    // Why: fileId is part of the dep array so switching between files (where
    // content can coincidentally match what was last committed for the prior
    // file) still triggers the content-sync path and prevents cross-file
    // drift from the renderer's draft cache.
  }, [content, editor, fileId])

  return (
    <div className="rich-markdown-editor-layout">
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
        {headerSlot}
        {/* Why: wrap scroll area + search bar in a relative container so the
          search bar overlays the content (Monaco-style) instead of occupying
          layout space and shifting the document down when opened. */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollContainerRef}
            className="h-full overflow-auto scrollbar-editor"
            onMouseDown={(event) => {
              if (!shouldFocusEmptyEditorFromSurfaceClick(event, editorRef.current)) {
                return
              }
              // Why: native contenteditable only places the caret on actual line
              // boxes; an empty note should still focus when the user clicks any
              // blank part of the document surface.
              event.preventDefault()
              editorRef.current?.commands.focus('start')
            }}
          >
            <EditorContent editor={editor} />
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
        {docLinkMenu ? (
          <RichMarkdownDocLinkMenu
            editor={editor}
            menu={docLinkMenu}
            rows={docLinkRows}
            totalMatches={docLinkTotalMatches}
            selectedIndex={selectedDocLinkIndex}
          />
        ) : null}
      </div>
      {showTableOfContents ? (
        <MarkdownTableOfContentsPanel
          items={tableOfContentsItems}
          onClose={onCloseTableOfContents ?? (() => {})}
          onNavigate={navigateToTableOfContentsItem}
        />
      ) : null}
    </div>
  )
}
