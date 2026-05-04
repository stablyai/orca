import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { isMarkdownPreviewFindShortcut } from './markdown-preview-search'
import {
  createRichMarkdownSearchPlugin,
  findRichMarkdownSearchMatches,
  richMarkdownSearchPluginKey
} from './rich-markdown-search'

export function useRichMarkdownSearch({
  editor,
  isMac,
  rootRef,
  scrollContainerRef
}: {
  editor: Editor | null
  isMac: boolean
  rootRef: RefObject<HTMLDivElement | null>
  scrollContainerRef: RefObject<HTMLDivElement | null>
}) {
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [rawActiveMatchIndex, setRawActiveMatchIndex] = useState(-1)
  const [searchRevision, setSearchRevision] = useState(0)
  // Why: debouncing the query that drives match computation prevents the
  // expensive full-doc walk from running on every keystroke — the old
  // un-debounced path froze the main thread on large documents.
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    if (!searchQuery) {
      setDebouncedQuery('')
      return
    }
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 150)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const matches = useMemo(() => {
    if (!editor || !isSearchOpen || !debouncedQuery) {
      return []
    }
    return findRichMarkdownSearchMatches(editor.state.doc, debouncedQuery)
    // searchRevision is bumped on ProseMirror doc edits to trigger recomputation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, isSearchOpen, debouncedQuery, searchRevision])

  const matchCount = matches.length

  // Clamp the user-controlled index to the valid range on every render.
  // No state update needed — this is a pure derivation.
  const activeMatchIndex =
    !isSearchOpen || matchCount === 0
      ? -1
      : rawActiveMatchIndex >= 0 && rawActiveMatchIndex < matchCount
        ? rawActiveMatchIndex
        : matchCount > 0
          ? 0
          : -1

  const openSearch = useCallback(() => {
    if (isSearchOpen) {
      // Why: same-value setState is a no-op so the focus effect won't re-fire.
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    } else {
      setIsSearchOpen(true)
    }
  }, [isSearchOpen])

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false)
    setSearchQuery('')
    setDebouncedQuery('')
    setRawActiveMatchIndex(-1)
  }, [])

  const moveToMatch = useCallback(
    (direction: 1 | -1) => {
      if (matchCount === 0) {
        return
      }

      // Why: rawActiveMatchIndex starts at -1 before the user navigates, but the
      // derived activeMatchIndex is already 0 (first match shown). Using 0 as the
      // base when raw is -1 ensures the first Enter press advances to match 1
      // instead of computing (-1+1)%N = 0 and leaving the effect unchanged.
      setRawActiveMatchIndex((currentIndex) => {
        const baseIndex = Math.max(currentIndex, 0)
        return (baseIndex + direction + matchCount) % matchCount
      })
    },
    [matchCount]
  )

  const handleEditorUpdate = useCallback(() => {
    setSearchRevision((current) => current + 1)
  }, [])

  useEffect(() => {
    if (!editor) {
      return
    }

    const plugin = createRichMarkdownSearchPlugin()
    editor.registerPlugin(plugin)

    return () => {
      editor.unregisterPlugin(richMarkdownSearchPluginKey)
    }
  }, [editor])

  useEffect(() => {
    if (!editor) {
      return
    }

    editor.on('update', handleEditorUpdate)
    return () => {
      editor.off('update', handleEditorUpdate)
    }
  }, [editor, handleEditorUpdate])

  useEffect(() => {
    if (!isSearchOpen) {
      return
    }
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [isSearchOpen])

  // Why: single effect to sync search state to ProseMirror. The old two-effect
  // chain (compute matches → set state → dispatch) caused an extra render cycle
  // and called findRichMarkdownSearchMatches twice per change.
  useEffect(() => {
    if (!editor) {
      return
    }

    const query = isSearchOpen ? debouncedQuery : ''

    // Why: combining decoration meta and selection+scrollIntoView into one
    // transaction avoids a split-dispatch where the first dispatch updates
    // editor.state and the second dispatch's scrollIntoView can be lost
    // when ProseMirror coalesces view updates.
    // Why: passing pre-computed matches avoids the plugin re-walking the
    // entire document — the old double-walk froze the UI on large files.
    const tr = editor.state.tr
    tr.setMeta(richMarkdownSearchPluginKey, {
      activeIndex: activeMatchIndex,
      matches,
      query
    })

    const activeMatch = query && activeMatchIndex >= 0 ? matches[activeMatchIndex] : null
    if (activeMatch) {
      tr.setSelection(TextSelection.create(tr.doc, activeMatch.from, activeMatch.to))
    }

    editor.view.dispatch(tr)

    // Why: ProseMirror's tr.scrollIntoView() delegates to the view's
    // scrollDOMIntoView which may fail to reach the outer flex scroll container
    // (the editor element itself has min-height: 100% and no overflow).
    // Reading coordsAtPos *after* the dispatch and manually scrolling the
    // container mirrors the approach used by MarkdownPreview search.
    if (activeMatch) {
      const container = scrollContainerRef.current
      if (container) {
        const coords = editor.view.coordsAtPos(activeMatch.from)
        const containerRect = container.getBoundingClientRect()
        const relativeTop = coords.top - containerRect.top
        const targetScroll = container.scrollTop + relativeTop - containerRect.height / 2
        container.scrollTo({ top: targetScroll, behavior: 'instant' })
      }
    }
  }, [activeMatchIndex, debouncedQuery, editor, isSearchOpen, matches, scrollContainerRef])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root) {
        return
      }

      const target = event.target
      const targetInsideEditor = target instanceof Node && root.contains(target)
      if (isMarkdownPreviewFindShortcut(event, isMac) && targetInsideEditor) {
        event.preventDefault()
        event.stopPropagation()
        openSearch()
        return
      }

      if (
        event.key === 'Escape' &&
        isSearchOpen &&
        (targetInsideEditor || target === searchInputRef.current)
      ) {
        event.preventDefault()
        event.stopPropagation()
        closeSearch()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [closeSearch, isMac, isSearchOpen, openSearch, rootRef])

  return {
    activeMatchIndex,
    closeSearch,
    isSearchOpen,
    matchCount,
    moveToMatch,
    openSearch,
    searchInputRef,
    searchQuery,
    setSearchQuery
  }
}
