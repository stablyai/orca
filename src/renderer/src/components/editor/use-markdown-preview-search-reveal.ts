import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Components } from 'react-markdown'
import type { Virtualizer } from '@tanstack/react-virtual'
import { listenMarkdownPreviewScrollInput } from './markdown-preview-scroll-input'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import {
  scrollMarkdownPreviewTo,
  getMarkdownPreviewAnchorScrollTop
} from './markdown-preview-anchor-navigation'
import type { MarkdownPreviewDocumentClient } from './markdown-preview-document-client'
import type {
  MarkdownPreviewDocumentMatch,
  MarkdownPreviewRenderedBlock
} from './markdown-preview-document-types'
import {
  applyMarkdownPreviewSearchHighlights,
  clearMarkdownPreviewSearchHighlights,
  setActiveMarkdownPreviewSearchMatch,
  type MarkdownPreviewSearchInstance
} from './markdown-preview-search'

type SearchReveal = {
  client: MarkdownPreviewDocumentClient
  query: string
  match: MarkdownPreviewDocumentMatch | undefined
  settled: boolean
}

export function useMarkdownPreviewSearchReveal({
  client,
  query,
  activeMatch,
  blocks,
  components,
  viewportReady,
  rootRef,
  bodyRef,
  virtualizer,
  searchInstance,
  scrollMarks
}: {
  client: MarkdownPreviewDocumentClient
  query: string
  activeMatch: MarkdownPreviewDocumentMatch | undefined
  blocks: MarkdownPreviewRenderedBlock[] | null
  components: Components
  viewportReady: boolean
  rootRef: RefObject<HTMLDivElement | null>
  bodyRef: RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  searchInstance: MarkdownPreviewSearchInstance
  scrollMarks: ProgrammaticScrollMarks
}): () => void {
  const reveal = useRef<SearchReveal | null>(null)
  const [navigationRequest, setNavigationRequest] = useState(0)
  const navigate = useCallback(() => {
    reveal.current = null
    setNavigationRequest((request) => request + 1)
  }, [])
  useEffect(() => {
    const container = rootRef.current
    if (!container) {
      return
    }
    const cancel = (): void => {
      reveal.current = { client, query, match: activeMatch, settled: true }
    }
    return listenMarkdownPreviewScrollInput(container, cancel)
  }, [activeMatch, client, query, rootRef])
  useEffect(() => {
    const previous = reveal.current
    if (previous?.client === client && previous.query === query && previous.match === undefined) {
      // Manual input during indexing cancels its first result, while Next can still navigate.
      previous.match = activeMatch
      return
    }
    if (activeMatch) {
      rootRef.current?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
      virtualizer.scrollToIndex(activeMatch.block, { align: 'center' })
    }
  }, [activeMatch, client, navigationRequest, query, rootRef, virtualizer])
  useEffect(() => {
    const body = bodyRef.current
    const container = rootRef.current
    if (!body || !container || !blocks) {
      return
    }
    const block = activeMatch
      ? body.querySelector<HTMLElement>(`[data-preview-block-index="${activeMatch.block}"]`)
      : null
    const ranges = block
      ? applyMarkdownPreviewSearchHighlights(searchInstance, block, query, { documentOnly: true })
      : []
    if (!block) {
      clearMarkdownPreviewSearchHighlights(searchInstance)
    }
    setActiveMarkdownPreviewSearchMatch(searchInstance, ranges, activeMatch?.occurrence ?? -1, {
      scrollIntoView: false
    })
    const range = ranges[activeMatch?.occurrence ?? -1]
    const previous = reveal.current
    const same =
      previous?.client === client && previous.query === query && previous.match === activeMatch
    if (
      activeMatch &&
      range &&
      viewportReady &&
      !virtualizer.isScrolling &&
      !(same && previous.settled)
    ) {
      const bounds = range.getBoundingClientRect()
      const viewport = container.getBoundingClientRect()
      const codeViewport = range.startContainer.parentElement?.closest('pre')
      const codeBounds = codeViewport?.getBoundingClientRect()
      const horizontalOffset = codeBounds
        ? bounds.left < codeBounds.left || bounds.width > codeBounds.width
          ? Math.floor(bounds.left - codeBounds.left)
          : Math.max(0, Math.ceil(bounds.right - codeBounds.right))
        : 0
      if (horizontalOffset && codeViewport) {
        codeViewport.scrollTo({ left: codeViewport.scrollLeft + horizontalOffset })
      }
      if (
        same &&
        bounds.bottom > viewport.top &&
        bounds.top < viewport.bottom &&
        !horizontalOffset
      ) {
        reveal.current = { client, query, match: activeMatch, settled: true }
        container.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
      } else {
        scrollMarkdownPreviewTo(
          container,
          getMarkdownPreviewAnchorScrollTop(container, range, 'center'),
          scrollMarks
        )
        reveal.current = { client, query, match: activeMatch, settled: false }
      }
    }
    return () => clearMarkdownPreviewSearchHighlights(searchInstance)
  }, [
    activeMatch,
    blocks,
    bodyRef,
    client,
    components,
    query,
    rootRef,
    searchInstance,
    navigationRequest,
    scrollMarks,
    viewportReady,
    virtualizer,
    virtualizer.isScrolling
  ])
  return navigate
}
