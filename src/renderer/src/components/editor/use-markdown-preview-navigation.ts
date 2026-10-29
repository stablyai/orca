import { useEffect, useImperativeHandle, useMemo, useRef, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import { listenMarkdownPreviewScrollInput } from './markdown-preview-scroll-input'
import {
  decodeMarkdownPreviewAnchor,
  getMarkdownPreviewAnchorScrollTop,
  scrollMarkdownPreviewTo
} from './markdown-preview-anchor-navigation'
import type {
  MarkdownPreviewDocument,
  MarkdownPreviewRenderedBlock
} from './markdown-preview-document-types'

export type PreviewReveal = { index: number } & (
  | { kind: 'anchor'; id: string }
  | { kind: 'source'; line: number }
)
export type VirtualMarkdownPreviewNavigation = {
  anchor: (id: string) => boolean
  sourceLine: (line: number) => boolean
  search: () => void
}
export function useMarkdownPreviewNavigation({
  document,
  rootRef,
  bodyRef,
  virtualizer,
  navigationRef,
  revealSearchMatch,
  renderedBlocks,
  viewportReady,
  anchor,
  setAnchor,
  scrollMarks
}: {
  document: MarkdownPreviewDocument
  rootRef: RefObject<HTMLDivElement | null>
  bodyRef: RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  navigationRef: RefObject<VirtualMarkdownPreviewNavigation | null>
  revealSearchMatch: () => void
  renderedBlocks: MarkdownPreviewRenderedBlock[] | null
  viewportReady: boolean
  anchor: PreviewReveal | null
  setAnchor: (anchor: PreviewReveal) => void
  scrollMarks: ProgrammaticScrollMarks
}): void {
  const completedAnchor = useRef<PreviewReveal | null>(null)
  useEffect(() => {
    const container = rootRef.current
    if (!anchor || !container) {
      return
    }
    return listenMarkdownPreviewScrollInput(container, () => {
      completedAnchor.current = anchor
    })
  }, [anchor, rootRef])
  const anchorBlocks = useMemo(
    () =>
      new Map(
        document.blocks.flatMap((block) => block.anchors.map((id) => [id, block.index] as const))
      ),
    [document]
  )
  useImperativeHandle(
    navigationRef,
    () => ({
      search: revealSearchMatch,
      anchor: (rawId) => {
        const id = decodeMarkdownPreviewAnchor(rawId)
        const index = anchorBlocks.get(id)
        if (index === undefined) {
          return false
        }
        rootRef.current?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
        virtualizer.scrollToIndex(index, { align: 'start' })
        setAnchor({ kind: 'anchor', id, index })
        return true
      },
      sourceLine: (line) => {
        const index = document.blocks.findIndex(
          (block) =>
            block.sourceLine !== null &&
            block.sourceLine <= line &&
            (block.sourceEndLine ?? block.sourceLine) >= line
        )
        if (index === -1) {
          return false
        }
        rootRef.current?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
        virtualizer.scrollToIndex(index, { align: 'center' })
        setAnchor({ kind: 'source', line, index })
        return true
      }
    }),
    [anchorBlocks, document, revealSearchMatch, rootRef, setAnchor, virtualizer]
  )
  useEffect(() => {
    const body = bodyRef.current
    const container = rootRef.current
    if (
      !anchor ||
      completedAnchor.current === anchor ||
      !body ||
      !container ||
      !renderedBlocks ||
      !viewportReady ||
      virtualizer.isScrolling
    ) {
      return
    }
    const block = body.querySelector<HTMLElement>(`[data-preview-block-index="${anchor.index}"]`)
    if (!block || !renderedBlocks.some((entry) => entry.index === anchor.index)) {
      return
    }
    const target =
      (anchor.kind === 'anchor'
        ? [...block.querySelectorAll<HTMLElement>('[id]')].find((node) => node.id === anchor.id)
        : [...block.querySelectorAll<HTMLElement>('[data-source-line][data-source-end-line]')].find(
            (node) =>
              Number(node.dataset.sourceLine) <= anchor.line &&
              Number(node.dataset.sourceEndLine) >= anchor.line
          )) ?? block
    const top = Math.min(
      getMarkdownPreviewAnchorScrollTop(
        container,
        target,
        anchor.kind === 'source' ? 'center' : 'start'
      ),
      Math.max(0, container.scrollHeight - container.clientHeight)
    )
    if (Math.abs(container.scrollTop - top) > 1) {
      scrollMarkdownPreviewTo(container, top, scrollMarks)
      return
    }
    container.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
    target.focus({ preventScroll: true })
    completedAnchor.current = anchor
  }, [
    anchor,
    bodyRef,
    renderedBlocks,
    rootRef,
    scrollMarks,
    viewportReady,
    virtualizer.isScrolling
  ])
}
