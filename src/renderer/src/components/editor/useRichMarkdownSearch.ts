import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import {
  isMarkdownPreviewFindShortcut,
  isMarkdownPreviewReplaceShortcut,
  isMarkdownPreviewSearchQueryTooLarge
} from './markdown-preview-search'
import {
  createRichMarkdownSearchPlugin,
  findRichMarkdownSearchMatches,
  richMarkdownSearchPluginKey
} from './rich-markdown-search'
import { createRichMarkdownSearchMatchesCache } from './rich-markdown-search-matches-cache'
import { useRichMarkdownSearchHighlights } from './useRichMarkdownSearchHighlights'

export function useRichMarkdownSearch({
  editor,
  rootRef,
  scrollContainerRef
}: {
  editor: Editor | null
  rootRef: RefObject<HTMLDivElement | null>
  scrollContainerRef: RefObject<HTMLDivElement | null>
}) {
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const keybindings = useAppStore((state) => state.keybindings)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const findMatches = useMemo(
    () =>
      editor && isSearchOpen
        ? createRichMarkdownSearchMatchesCache()
        : findRichMarkdownSearchMatches,
    [editor, isSearchOpen]
  )
  const [isReplaceMode, setIsReplaceMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [replaceQuery, setReplaceQuery] = useState('')
  // Why: match-case / whole-word persist across find sessions (matching the
  // source editor's find widget), so they live outside the close-reset path.
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [rawActiveMatchIndex, setRawActiveMatchIndex] = useState(-1)
  const [navigationRequest, setNavigationRequest] = useState({ revision: 0, selectMatch: false })
  const [, setSearchRevision] = useState(0)
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
  const searchRequestQuery = isMarkdownPreviewSearchQueryTooLarge(debouncedQuery)
    ? ''
    : debouncedQuery
  const searchDocument = editor && !editor.isDestroyed ? editor.state.doc : null

  const matches = useMemo(() => {
    if (!searchDocument || !isSearchOpen || !searchRequestQuery) {
      return []
    }
    return findMatches(searchDocument, searchRequestQuery, {
      matchCase,
      wholeWord
    })
  }, [findMatches, isSearchOpen, searchRequestQuery, searchDocument, matchCase, wholeWord])

  const matchCount = matches.length

  const getLiveMatches = useCallback(() => {
    if (
      !editor ||
      editor.isDestroyed ||
      !isSearchOpen ||
      !searchQuery ||
      isMarkdownPreviewSearchQueryTooLarge(searchQuery)
    ) {
      return []
    }
    // Why: replace mutates document ranges immediately, so it must use the
    // current input value instead of the debounced highlight match set.
    return findMatches(editor.state.doc, searchQuery, {
      matchCase,
      wholeWord
    })
  }, [editor, findMatches, isSearchOpen, matchCase, searchQuery, wholeWord])

  // Why: mirror the guard used by replaceCurrentMatch/replaceAllMatches so the
  // disabled state never disagrees with what a click will actually do during the
  // debounce window when live matches diverge from the highlight set.
  const replaceDisabled = getLiveMatches().some((match) => match.touchesReadOnlyAtom)

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

  const openReplace = useCallback(() => {
    setIsReplaceMode(true)
    if (isSearchOpen) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    } else {
      setIsSearchOpen(true)
    }
  }, [isSearchOpen])

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false)
    setIsReplaceMode(false)
    setSearchQuery('')
    setReplaceQuery('')
    setDebouncedQuery('')
    setRawActiveMatchIndex(-1)
    // Why: closing the bar unmounts the focused search input, dropping focus to
    // <body> — outside the editor root — so the find/replace shortcut's
    // targetInsideEditor guard would ignore the next keypress until the user
    // re-clicks the editor. Returning focus to the editor keeps reopening via
    // keyboard working and restores the caret to the document.
    editor?.commands.focus()
  }, [editor])

  const toggleMatchCase = useCallback(() => setMatchCase((value) => !value), [])
  const toggleWholeWord = useCallback(() => setWholeWord((value) => !value), [])
  const toggleReplaceMode = useCallback(() => setIsReplaceMode((value) => !value), [])

  const replaceRange = useCallback(
    (from: number, to: number) => {
      if (!editor) {
        return
      }
      const tr = editor.state.tr
      // Why: empty replacement must delete the range — ProseMirror text nodes
      // can't hold an empty string, so insertText('') would be a no-op.
      if (replaceQuery) {
        tr.insertText(replaceQuery, from, to)
      } else {
        tr.delete(from, to)
      }
      editor.view.dispatch(tr)
    },
    [editor, replaceQuery]
  )

  const replaceCurrentMatch = useCallback(() => {
    const liveMatches = getLiveMatches()
    if (liveMatches.length === 0) {
      return
    }
    const liveActiveMatchIndex =
      activeMatchIndex >= 0 && activeMatchIndex < liveMatches.length ? activeMatchIndex : 0
    const match = liveMatches[liveActiveMatchIndex]
    if (!match || liveMatches.some((candidate) => candidate.touchesReadOnlyAtom)) {
      return
    }
    replaceRange(match.from, match.to)
    // Skip matches inside the replacement, including when it still contains the query.
    const replacementEnd = match.from + replaceQuery.length
    const nextIndex = getLiveMatches().findIndex((candidate) => candidate.from >= replacementEnd)
    setRawActiveMatchIndex(Math.max(0, nextIndex))
    setDebouncedQuery(searchQuery)
    setNavigationRequest((request) => ({ revision: request.revision + 1, selectMatch: true }))
  }, [activeMatchIndex, getLiveMatches, replaceQuery, replaceRange, searchQuery])

  const replaceAllMatches = useCallback(() => {
    if (!editor) {
      return
    }
    const liveMatches = getLiveMatches()
    if (
      liveMatches.length === 0 ||
      liveMatches.some((candidate) => candidate.touchesReadOnlyAtom)
    ) {
      return
    }
    const tr = editor.state.tr
    // Why: process matches last-to-first so each edit can't invalidate the
    // positions of matches we haven't replaced yet, keeping it a single undo.
    for (let index = liveMatches.length - 1; index >= 0; index -= 1) {
      const match = liveMatches[index]
      if (replaceQuery) {
        tr.insertText(replaceQuery, match.from, match.to)
      } else {
        tr.delete(match.from, match.to)
      }
    }
    editor.view.dispatch(tr)
    setDebouncedQuery(searchQuery)
    setNavigationRequest((request) => ({ revision: request.revision + 1, selectMatch: false }))
  }, [editor, getLiveMatches, replaceQuery, searchQuery])

  const moveToMatch = useCallback(
    (direction: 1 | -1) => {
      const liveMatchCount = getLiveMatches().length
      if (liveMatchCount === 0) {
        return
      }

      setRawActiveMatchIndex((currentIndex) => {
        const baseIndex = currentIndex >= 0 && currentIndex < liveMatchCount ? currentIndex : 0
        return (baseIndex + direction + liveMatchCount) % liveMatchCount
      })
      setDebouncedQuery(searchQuery)
      setNavigationRequest((request) => ({ revision: request.revision + 1, selectMatch: true }))
    },
    [getLiveMatches, searchQuery]
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
    if (!editor || !isSearchOpen) {
      return
    }

    editor.on('update', handleEditorUpdate)
    return () => {
      editor.off('update', handleEditorUpdate)
    }
  }, [editor, handleEditorUpdate, isSearchOpen])

  useEffect(() => {
    if (!isSearchOpen) {
      return
    }
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [isSearchOpen])

  useRichMarkdownSearchHighlights({
    activeMatchIndex,
    editor,
    matchCase,
    matches,
    navigationRequest,
    query: isSearchOpen ? searchRequestQuery : '',
    scrollContainerRef,
    wholeWord,
    rootRef,
    searchDocument
  })

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root) {
        return
      }

      const target = event.target
      const targetInsideEditor = target instanceof Node && root.contains(target)
      if (
        isMarkdownPreviewFindShortcut(event, getShortcutPlatform(), keybindings) &&
        targetInsideEditor
      ) {
        event.preventDefault()
        event.stopPropagation()
        openSearch()
        return
      }

      if (
        isMarkdownPreviewReplaceShortcut(event, getShortcutPlatform(), keybindings) &&
        targetInsideEditor
      ) {
        event.preventDefault()
        event.stopPropagation()
        openReplace()
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
  }, [closeSearch, isSearchOpen, keybindings, openReplace, openSearch, rootRef])

  return {
    openSearch,
    searchState: {
      activeMatchIndex,
      isReplaceMode,
      isSearchOpen,
      matchCase,
      matchCount,
      replaceQuery,
      replaceDisabled,
      searchQuery,
      searchInputRef,
      wholeWord
    },
    searchActions: {
      closeSearch,
      moveToMatch,
      replaceAllMatches,
      replaceCurrentMatch,
      setReplaceQuery,
      setSearchQuery,
      toggleMatchCase,
      toggleReplaceMode,
      toggleWholeWord
    }
  }
}
