import type { MarkdownPreviewDocument } from './markdown-preview-document-types'
import type { VirtualMarkdownPreviewNavigation } from './VirtualMarkdownPreviewBody'
import { useCallback, useEffect, useLayoutEffect, type MutableRefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { resolveMarkdownPreviewAddReviewNoteKey } from './markdown-preview-annotation-shortcut'
import {
  decodeMarkdownPreviewAnchor,
  getMarkdownPreviewAnchorScrollTop
} from './markdown-preview-anchor-navigation'
import { cancelMarkdownPreviewEditorRevealFrames } from './markdown-preview-editor-reveal'
import { clearMarkdownPreviewReviewTimers } from './markdown-preview-review-timer-cleanup'
import { isMarkdownPreviewFindShortcut } from './markdown-preview-search'
import { useMarkdownPreviewDomSearch } from './use-markdown-preview-dom-search'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import { useMarkdownPreviewScrollViewport } from './use-markdown-preview-scroll-viewport'

export function useMarkdownPreviewViewport({
  foundation,
  scrollCacheKey,
  initialAnchor,
  content,
  markdownAnnotationsEnabled,
  largePreview = false,
  largeDocument = null,
  largeNavigationRef
}: {
  foundation: MarkdownPreviewFoundation
  scrollCacheKey: string
  initialAnchor: string | null
  content: string
  largePreview?: boolean
  largeDocument?: MarkdownPreviewDocument | null
  largeNavigationRef?: MutableRefObject<VirtualMarkdownPreviewNavigation | null>
  markdownAnnotationsEnabled: boolean
}) {
  const {
    rootRef,
    bodyRef,
    inputRef,
    matchesRef,
    lastAppliedInitialAnchorRef,
    pendingEditorRevealFrameIdsRef,
    isSearchOpen,
    setIsSearchOpen,
    setQuery,
    matchCount,
    setActiveMatchIndex,
    keybindings,
    activeAnnotationBlockKeyRef,
    setActiveAnnotationBlockKey,
    reviewNotesCopiedResetTimerRef,
    copiedReviewNoteResetTimerRef,
    reviewNotesCopyMountedRef,
    attentionReviewCommentTimeoutRef,
    pendingReviewActionFrameIdsRef,
    pendingReviewActionTimeoutIdsRef,
    reviewActionFrameGenerationRef
  } = foundation

  useMarkdownPreviewScrollViewport({
    foundation,
    scrollCacheKey,
    restorePixels: !largePreview
  })

  const moveToMatch = useCallback(
    (direction: 1 | -1) => {
      const count = largePreview ? matchCount : matchesRef.current.length
      if (count === 0) {
        return
      }
      setActiveMatchIndex((cur) => {
        const base = cur >= 0 ? cur : direction === 1 ? -1 : 0
        return (base + direction + count) % count
      })
    },
    [largePreview, matchCount, matchesRef, setActiveMatchIndex]
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
    reviewActionFrameGenerationRef.current += 1
    const reviewFrames = pendingReviewActionFrameIdsRef.current
    pendingReviewActionFrameIdsRef.current = []
    const reviewTimeouts = pendingReviewActionTimeoutIdsRef.current
    pendingReviewActionTimeoutIdsRef.current = []
    cancelMarkdownPreviewEditorRevealFrames(pendingEditorRevealFrameIdsRef)
    clearMarkdownPreviewReviewTimers(attentionReviewCommentTimeoutRef, reviewTimeouts)
    clearReviewNotesCopiedResetTimer()
    clearCopiedReviewNoteResetTimer()
    cancelMarkdownPreviewEditorRevealFrames({ current: reviewFrames })
  }, [
    attentionReviewCommentTimeoutRef,
    clearCopiedReviewNoteResetTimer,
    clearReviewNotesCopiedResetTimer,
    pendingEditorRevealFrameIdsRef,
    pendingReviewActionFrameIdsRef,
    pendingReviewActionTimeoutIdsRef,
    reviewActionFrameGenerationRef
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
      if (largePreview) {
        return largeNavigationRef?.current?.anchor(rawAnchor) ?? false
      }
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
    [bodyRef, rootRef, largeNavigationRef, largePreview]
  )

  const scrollToSourceLine = useCallback(
    (line: number): boolean =>
      largePreview ? (largeNavigationRef?.current?.sourceLine(line) ?? false) : false,
    [largeNavigationRef, largePreview]
  )

  const navigateToTableOfContentsItem = useCallback(
    (id: string): void => {
      scrollToAnchor(id)
    },
    [scrollToAnchor]
  )

  useMarkdownPreviewDomSearch(foundation, largePreview)

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
  }, [content, initialAnchor, largeDocument, lastAppliedInitialAnchorRef, scrollToAnchor])

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
    scrollToSourceLine,
    navigateToTableOfContentsItem
  }
}

export type MarkdownPreviewViewport = ReturnType<typeof useMarkdownPreviewViewport>
