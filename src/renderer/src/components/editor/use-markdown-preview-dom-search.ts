import { useEffect, useState } from 'react'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import {
  applyMarkdownPreviewSearchHighlights,
  clearMarkdownPreviewSearchHighlights,
  setActiveMarkdownPreviewSearchMatch
} from './markdown-preview-search'
import { isTextSearchQueryTooLarge } from '@renderer/lib/text-match-ranges'
import { captureMarkdownDocumentRevision } from './markdown-document-revision'
import { listenMarkdownPreviewScrollInput } from './markdown-preview-scroll-input'
import {
  cancelMermaidNavigation,
  registerMermaidNavigation,
  renderMermaidDiagrams,
  settleMermaidNavigation
} from './use-mermaid-viewport'

export function useMarkdownPreviewDomSearch(
  foundation: MarkdownPreviewFoundation,
  disabled: boolean
) {
  const {
    bodyRef,
    rootRef,
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
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle')
  useEffect(() => {
    const body = bodyRef.current
    const container = rootRef.current
    if (disabled || !body || !container) {
      setState('idle')
      return
    }

    const instanceId = searchInstanceRef.current
    if (!isSearchOpen) {
      setState('idle')
      matchesRef.current = []
      setMatchCount(0)
      clearMarkdownPreviewSearchHighlights(instanceId)
      return
    }

    const projectMatches = (reveal: boolean): void => {
      const matches = applyMarkdownPreviewSearchHighlights(instanceId, body, query)
      matchesRef.current = matches
      setMatchCount(matches.length)
      setSearchRevision((value) => value + 1)
      setActiveMatchIndex((cur) =>
        !reveal || matches.length === 0 ? -1 : cur >= 0 && cur < matches.length ? cur : 0
      )
    }
    const pending =
      query && !isTextSearchQueryTooLarge(query) ? renderMermaidDiagrams(body) : undefined
    if (!pending) {
      setState('idle')
      projectMatches(true)
      return () => clearMarkdownPreviewSearchHighlights(instanceId)
    }

    matchesRef.current = []
    setMatchCount(0)
    clearMarkdownPreviewSearchHighlights(instanceId)
    setState('pending')
    let current = true
    let shouldReveal = true
    const isCurrentDocument = captureMarkdownDocumentRevision(body)
    cancelMermaidNavigation(container)
    const cancelReveal = (): void => {
      shouldReveal = false
      stopListening()
      unregister()
    }
    const stopListening = listenMarkdownPreviewScrollInput(container, cancelReveal)
    const unregister = registerMermaidNavigation(container, cancelReveal)
    const cleanup = (): void => {
      stopListening()
      unregister()
    }
    void pending
      .then(() => {
        if (!current) {
          return
        }
        if (
          bodyRef.current !== body ||
          rootRef.current !== container ||
          !body.isConnected ||
          !isCurrentDocument()
        ) {
          setState('failed')
          return
        }
        projectMatches(shouldReveal)
        setState('idle')
      })
      .catch(() => {
        if (current) {
          setState('failed')
        }
      })
      .finally(cleanup)
    return () => {
      current = false
      cleanup()
      clearMarkdownPreviewSearchHighlights(instanceId)
    }
  }, [
    bodyRef,
    disabled,
    isSearchOpen,
    matchesRef,
    query,
    renderedContent,
    rootRef,
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
    const container = rootRef.current
    if (container && matchesRef.current[activeMatchIndex]) {
      return settleMermaidNavigation(container, () => {
        setActiveMarkdownPreviewSearchMatch(
          searchInstanceRef.current,
          matchesRef.current,
          activeMatchIndex
        )
      })
    }
    return undefined
  }, [
    activeMatchIndex,
    disabled,
    matchCount,
    matchesRef,
    rootRef,
    searchInstanceRef,
    searchRevision
  ])

  return {
    pending: !disabled && isSearchOpen && query.length > 0 && state === 'pending',
    failed: !disabled && isSearchOpen && query.length > 0 && state === 'failed'
  }
}
