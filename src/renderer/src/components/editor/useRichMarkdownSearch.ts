import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
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
  const [isReplaceMode, setIsReplaceMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [replaceQuery, setReplaceQuery] = useState('')
  // Why: match-case / whole-word persist across find sessions (matching the
  // source editor's find widget), so they live outside the close-reset path.
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
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
  const searchRequestQuery = isMarkdownPreviewSearchQueryTooLarge(debouncedQuery)
    ? ''
    : debouncedQuery

  const matches = useMemo(() => {
    if (!editor || !isSearchOpen || !searchRequestQuery) {
      return []
    }
    return findRichMarkdownSearchMatches(editor.state.doc, searchRequestQuery, {
      matchCase,
      wholeWord
    })
    // searchRevision is bumped on ProseMirror doc edits to trigger recomputation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, isSearchOpen, searchRequestQuery, searchRevision, matchCase, wholeWord])

  const matchCount = matches.length

  const getLiveMatches = useCallback(() => {
    if (
      !editor ||
      !isSearchOpen ||
      !searchQuery ||
      isMarkdownPreviewSearchQueryTooLarge(searchQuery)
    ) {
      return []
    }
    // Why: replace mutates document ranges immediately, so it must use the
    // current input value instead of the debounced highlight match set.
    return findRichMarkdownSearchMatches(editor.state.doc, searchQuery, {
      matchCase,
      wholeWord
    })
  }, [editor, isSearchOpen, matchCase, searchQuery, wholeWord])

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
    // Why: removing the active match shifts the next match into the same index,
    // so leaving rawActiveMatchIndex untouched advances to it after recompute.
    replaceRange(match.from, match.to)
  }, [activeMatchIndex, getLiveMatches, replaceRange])

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
  }, [editor, getLiveMatches, replaceQuery])

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

    const query = isSearchOpen ? searchRequestQuery : ''

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
  }, [activeMatchIndex, searchRequestQuery, editor, isSearchOpen, matches, scrollContainerRef])

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
