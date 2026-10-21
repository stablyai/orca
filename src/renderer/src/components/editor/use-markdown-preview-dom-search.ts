import { useEffect } from 'react'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import {
  applyMarkdownPreviewSearchHighlights,
  clearMarkdownPreviewSearchHighlights,
  setActiveMarkdownPreviewSearchMatch
} from './markdown-preview-search'

export function useMarkdownPreviewDomSearch(
  foundation: MarkdownPreviewFoundation,
  disabled: boolean
): void {
  const {
    bodyRef,
    searchInstanceRef,
    isSearchOpen,
    matchesRef,
    query,
    renderedContent,
    setActiveMatchIndex,
    setMatchCount,
    setSearchRevision,
    activeMatchIndex,
    matchCount,
    searchRevision
  } = foundation
  useEffect(() => {
    const body = bodyRef.current
    if (disabled || !body) {
      return
    }

    const instanceId = searchInstanceRef.current

    if (!isSearchOpen) {
      matchesRef.current = []
      setMatchCount(0)
      clearMarkdownPreviewSearchHighlights(instanceId)
      return
    }

    const matches = applyMarkdownPreviewSearchHighlights(instanceId, body, query)
    matchesRef.current = matches
    setMatchCount(matches.length)
    setSearchRevision((value) => value + 1)
    setActiveMatchIndex((cur) =>
      matches.length === 0 ? -1 : cur >= 0 && cur < matches.length ? cur : 0
    )

    return () => clearMarkdownPreviewSearchHighlights(instanceId)
  }, [
    bodyRef,
    disabled,
    isSearchOpen,
    matchesRef,
    query,
    renderedContent,
    searchInstanceRef,
    setActiveMatchIndex,
    setMatchCount,
    setSearchRevision
  ])

  useEffect(() => {
    if (disabled) {
      return
    }
    setActiveMarkdownPreviewSearchMatch(
      searchInstanceRef.current,
      matchesRef.current,
      activeMatchIndex
    )
  }, [activeMatchIndex, disabled, matchCount, matchesRef, searchInstanceRef, searchRevision])
}
