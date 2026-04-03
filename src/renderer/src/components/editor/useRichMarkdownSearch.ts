import { useCallback, useEffect, useRef, useState } from 'react'
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
  rootRef
}: {
  editor: Editor | null
  isMac: boolean
  rootRef: RefObject<HTMLDivElement | null>
}) {
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1)
  const [searchRevision, setSearchRevision] = useState(0)

  const openSearch = useCallback(() => {
    setIsSearchOpen(true)
  }, [])

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false)
    setSearchQuery('')
    setActiveMatchIndex(-1)
    setMatchCount(0)
  }, [])

  const moveToMatch = useCallback(
    (direction: 1 | -1) => {
      if (matchCount === 0) {
        return
      }

      setActiveMatchIndex((currentIndex) => {
        const baseIndex = currentIndex >= 0 ? currentIndex : direction === 1 ? -1 : 0
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

  useEffect(() => {
    if (!editor) {
      return
    }

    if (!isSearchOpen || !searchQuery) {
      setMatchCount(0)
      setActiveMatchIndex(-1)
      editor.view.dispatch(
        editor.state.tr.setMeta(richMarkdownSearchPluginKey, {
          activeIndex: -1,
          query: ''
        })
      )
      return
    }

    const matches = findRichMarkdownSearchMatches(editor.state.doc, searchQuery)
    setMatchCount(matches.length)
    setActiveMatchIndex((currentIndex) => {
      if (matches.length === 0) {
        return -1
      }
      if (currentIndex >= 0 && currentIndex < matches.length) {
        return currentIndex
      }
      return 0
    })
  }, [editor, isSearchOpen, searchQuery, searchRevision])

  useEffect(() => {
    if (!editor) {
      return
    }

    const query = isSearchOpen ? searchQuery : ''
    editor.view.dispatch(
      editor.state.tr.setMeta(richMarkdownSearchPluginKey, {
        activeIndex: activeMatchIndex,
        query
      })
    )

    if (!query || activeMatchIndex < 0) {
      return
    }

    const matches = findRichMarkdownSearchMatches(editor.state.doc, query)
    const activeMatch = matches[activeMatchIndex]
    if (!activeMatch) {
      return
    }

    // Why: rich-mode find should navigate within the editor model instead of
    // the rendered DOM so highlight positions stay correct while the user edits.
    // Updating the ProseMirror selection keeps scroll-to-match aligned with the
    // actual markdown document rather than the transient browser layout.
    const tr = editor.state.tr
    tr.setSelection(TextSelection.create(tr.doc, activeMatch.from, activeMatch.to))
    tr.scrollIntoView()
    editor.view.dispatch(tr)
  }, [activeMatchIndex, editor, isSearchOpen, searchQuery])

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
