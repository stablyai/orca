// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { Virtualizer } from '@tanstack/react-virtual'
import { expect, it, vi } from 'vitest'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import {
  parseMarkdownPreviewDocument,
  renderMarkdownPreviewBlock
} from './markdown-preview-document-tree'
import {
  useMarkdownPreviewNavigation,
  type PreviewReveal,
  type VirtualMarkdownPreviewNavigation
} from './use-markdown-preview-navigation'

it.each(['anchor', 'source'] as const)(
  'records exact %s navigation only after the requested viewport and scrolling settle',
  (kind) => {
    const { document: preview, tree } = parseMarkdownPreviewDocument('# Destination')
    const root = document.createElement('div')
    const block = document.createElement('div')
    block.dataset.previewBlockIndex = '0'
    const heading = document.createElement('h1')
    heading.id = 'destination'
    heading.dataset.sourceLine = '1'
    heading.dataset.sourceEndLine = '1'
    block.append(heading)
    root.append(block)
    Object.defineProperties(root, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 100 }
    })
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100))
    vi.spyOn(heading, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 400 - root.scrollTop, 100, 40)
    )
    const scroll = vi
      .spyOn(root, 'scrollTo')
      .mockImplementation((options: number | ScrollToOptions) => {
        if (typeof options === 'object') {
          root.scrollTop = options.top ?? root.scrollTop
        }
      })
    const record = vi.fn()
    root.addEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, record)
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 1,
      getScrollElement: () => root,
      estimateSize: () => 100,
      scrollToFn: () => {},
      observeElementRect: () => () => {},
      observeElementOffset: () => () => {}
    })
    vi.spyOn(virtualizer, 'scrollToIndex').mockImplementation(() => {})
    const navigationRef: { current: VirtualMarkdownPreviewNavigation | null } = { current: null }
    const options = {
      document: preview,
      rootRef: { current: root },
      bodyRef: { current: root },
      virtualizer,
      navigationRef,
      revealSearchMatch: vi.fn(),
      renderedBlocks: [renderMarkdownPreviewBlock(tree.children[0], 0)],
      scrollMarks: createProgrammaticScrollMarks(),
      setAnchor: vi.fn()
    }
    const initial: { anchor: PreviewReveal | null; viewportReady: boolean } = {
      anchor: null,
      viewportReady: false
    }
    const { rerender, unmount } = renderHook(
      (props) => useMarkdownPreviewNavigation({ ...options, ...props }),
      { initialProps: initial }
    )
    act(() =>
      expect(
        kind === 'anchor'
          ? navigationRef.current?.anchor('destination')
          : navigationRef.current?.sourceLine(1)
      ).toBe(true)
    )
    expect(record).toHaveBeenCalledOnce()
    record.mockClear()
    const anchor: PreviewReveal =
      kind === 'anchor' ? { kind, id: 'destination', index: 0 } : { kind, line: 1, index: 0 }
    rerender({ anchor, viewportReady: false })
    expect(scroll).not.toHaveBeenCalled()
    virtualizer.isScrolling = true
    rerender({ anchor, viewportReady: true })
    expect(scroll).not.toHaveBeenCalled()
    virtualizer.isScrolling = false
    rerender({ anchor, viewportReady: true })
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: kind === 'anchor' ? 388 : 370 })
    expect(record).not.toHaveBeenCalled()
    virtualizer.isScrolling = true
    rerender({ anchor, viewportReady: true })
    virtualizer.isScrolling = false
    rerender({ anchor, viewportReady: true })
    expect(record).toHaveBeenCalledOnce()
    const cancelledAnchor = { ...anchor }
    root.scrollTop = 0
    rerender({ anchor: cancelledAnchor, viewportReady: false })
    act(() => root.dispatchEvent(new Event('wheel')))
    rerender({ anchor: cancelledAnchor, viewportReady: true })
    expect(scroll).toHaveBeenCalledOnce()
    expect(record).toHaveBeenCalledOnce()
    unmount()
  }
)
