import { useCallback, useEffect, useLayoutEffect, type MutableRefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { resolveMarkdownPreviewAddReviewNoteKey } from './markdown-preview-annotation-shortcut'
import {
  decodeMarkdownPreviewAnchor,
  getMarkdownPreviewAnchorScrollTop
} from './markdown-preview-anchor-navigation'
import { cancelMarkdownPreviewEditorRevealFrames } from './markdown-preview-editor-reveal'
import {
  applyMarkdownPreviewSearchHighlights,
  clearMarkdownPreviewSearchHighlights,
  isMarkdownPreviewFindShortcut,
  setActiveMarkdownPreviewSearchMatch
} from './markdown-preview-search'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import { useMarkdownPreviewScrollViewport } from './use-markdown-preview-scroll-viewport'

function clearMarkdownPreviewTimeout(timeoutRef: MutableRefObject<number | null>): void {
  if (timeoutRef.current === null) {
    return
  }
  window.clearTimeout(timeoutRef.current)
  timeoutRef.current = null
}

export function useMarkdownPreviewViewport({
  foundation,
  scrollCacheKey,
  initialAnchor,
  content,
  markdownAnnotationsEnabled
}: {
  foundation: MarkdownPreviewFoundation
  scrollCacheKey: string
  initialAnchor: string | null
  content: string
  markdownAnnotationsEnabled: boolean
}) {
  const {
    rootRef,
    bodyRef,
    inputRef,
    matchesRef,
    searchInstanceRef,
    lastAppliedInitialAnchorRef,
    pendingEditorRevealFrameIdsRef,
    isSearchOpen,
    setIsSearchOpen,
    query,
    setQuery,
    matchCount,
    setMatchCount,
    searchRevision,
    setSearchRevision,
    activeMatchIndex,
    setActiveMatchIndex,
    keybindings,
    activeAnnotationBlockKeyRef,
    setActiveAnnotationBlockKey,
    reviewNotesCopiedResetTimerRef,
    copiedReviewNoteResetTimerRef,
    reviewNotesCopyMountedRef,
    attentionReviewCommentTimeoutRef,
    renderedContent
  } = foundation

  useMarkdownPreviewScrollViewport({ foundation, scrollCacheKey })

  const moveToMatch = useCallback(
    (direction: 1 | -1) => {
      if (matchesRef.current.length === 0) {
        return
      }
      setActiveMatchIndex((cur) => {
        const base = cur >= 0 ? cur : direction === 1 ? -1 : 0
        return (base + direction + matchesRef.current.length) % matchesRef.current.length
      })
    },
    [matchesRef, setActiveMatchIndex]
  )

  const openSearch = useCallback(() => {
    if (isSearchOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      setIsSearchOpen(true)
    }
  }, [inputRef, isSearchOpen, setIsSearchOpen])

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false)
    setQuery('')
    setActiveMatchIndex(-1)
  }, [setActiveMatchIndex, setIsSearchOpen, setQuery])

  const clearReviewNotesCopiedResetTimer = useCallback((): void => {
    if (reviewNotesCopiedResetTimerRef.current !== null) {
      window.clearTimeout(reviewNotesCopiedResetTimerRef.current)
      reviewNotesCopiedResetTimerRef.current = null
    }
  }, [reviewNotesCopiedResetTimerRef])

  const clearCopiedReviewNoteResetTimer = useCallback((): void => {
    if (copiedReviewNoteResetTimerRef.current !== null) {
      window.clearTimeout(copiedReviewNoteResetTimerRef.current)
      copiedReviewNoteResetTimerRef.current = null
    }
  }, [copiedReviewNoteResetTimerRef])

  const cleanupPreviewSurfaceTimers = useCallback((): void => {
    cancelMarkdownPreviewEditorRevealFrames(pendingEditorRevealFrameIdsRef)
    clearMarkdownPreviewTimeout(attentionReviewCommentTimeoutRef)
    clearReviewNotesCopiedResetTimer()
    clearCopiedReviewNoteResetTimer()
  }, [
    attentionReviewCommentTimeoutRef,
    clearCopiedReviewNoteResetTimer,
    clearReviewNotesCopiedResetTimer,
    pendingEditorRevealFrameIdsRef
  ])

  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node
      reviewNotesCopyMountedRef.current = node !== null
      if (node === null) {
        cleanupPreviewSurfaceTimers()
      }
    },
    [cleanupPreviewSurfaceTimers, reviewNotesCopyMountedRef, rootRef]
  )

  const scrollToAnchor = useCallback(
    (rawAnchor: string): boolean => {
      const container = rootRef.current
      const body = bodyRef.current
      if (!container || !body) {
        return false
      }

      const decodedAnchor = decodeMarkdownPreviewAnchor(rawAnchor)
      let target: HTMLElement | null = null
      for (const candidate of body.querySelectorAll<HTMLElement>('[id]')) {
        if (candidate.id === decodedAnchor) {
          target = candidate
          break
        }
      }
      if (!target) {
        return false
      }

      container.scrollTo({ top: getMarkdownPreviewAnchorScrollTop(container, target) })
      target.focus({ preventScroll: true })
      return true
    },
    [bodyRef, rootRef]
  )

  const navigateToTableOfContentsItem = useCallback(
    (id: string): void => {
      scrollToAnchor(id)
    },
    [scrollToAnchor]
  )

  useEffect(() => {
    const body = bodyRef.current
    if (!body) {
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
    setActiveMarkdownPreviewSearchMatch(
      searchInstanceRef.current,
      matchesRef.current,
      activeMatchIndex
    )
  }, [activeMatchIndex, matchCount, matchesRef, searchInstanceRef, searchRevision])

  useLayoutEffect(() => {
    if (!initialAnchor || initialAnchor === lastAppliedInitialAnchorRef.current) {
      return
    }

    let frameId = 0
    let attempts = 0

    const tryRevealAnchor = (): void => {
      if (scrollToAnchor(initialAnchor)) {
        lastAppliedInitialAnchorRef.current = initialAnchor
        return
      }

      attempts += 1
      if (attempts < 30) {
        frameId = window.requestAnimationFrame(tryRevealAnchor)
      }
    }

    tryRevealAnchor()
    return () => window.cancelAnimationFrame(frameId)
  }, [content, initialAnchor, lastAppliedInitialAnchorRef, scrollToAnchor])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root) {
        return
      }

      const target = event.target
      const targetInsidePreview = target instanceof Node && root.contains(target)

      if (
        isMarkdownPreviewFindShortcut(event, getShortcutPlatform(), keybindings) &&
        targetInsidePreview
      ) {
        event.preventDefault()
        event.stopPropagation()
        openSearch()
        return
      }

      const reviewNoteKey = resolveMarkdownPreviewAddReviewNoteKey({
        event,
        platform: getShortcutPlatform(),
        keybindings,
        targetInsidePreview,
        markdownAnnotationsEnabled,
        activeAnnotationBlockKey: activeAnnotationBlockKeyRef.current,
        root,
        selection: window.getSelection()
      })
      if (reviewNoteKey.action === 'consume') {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (reviewNoteKey.action === 'clear-stale-and-ignore') {
        activeAnnotationBlockKeyRef.current = null
        setActiveAnnotationBlockKey(null)
        return
      }
      if (reviewNoteKey.action === 'open') {
        event.preventDefault()
        event.stopPropagation()
        activeAnnotationBlockKeyRef.current = reviewNoteKey.blockKey
        setActiveAnnotationBlockKey(reviewNoteKey.blockKey)
        return
      }

      if (!isSearchOpen) {
        return
      }

      if (event.key === 'Escape' && (targetInsidePreview || target === inputRef.current)) {
        event.preventDefault()
        event.stopPropagation()
        closeSearch()
        root.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [
    activeAnnotationBlockKeyRef,
    closeSearch,
    inputRef,
    isSearchOpen,
    keybindings,
    markdownAnnotationsEnabled,
    openSearch,
    rootRef,
    setActiveAnnotationBlockKey
  ])

  return {
    moveToMatch,
    closeSearch,
    clearReviewNotesCopiedResetTimer,
    clearCopiedReviewNoteResetTimer,
    setRootRef,
    scrollToAnchor,
    navigateToTableOfContentsItem
  }
}

export type MarkdownPreviewViewport = ReturnType<typeof useMarkdownPreviewViewport>
