// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { Virtualizer } from '@tanstack/react-virtual'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreviewDocumentClient } from './markdown-preview-document-client'
import type { MarkdownPreviewDocumentMatch } from './markdown-preview-document-types'
import { useMarkdownPreviewSearchReveal } from './use-markdown-preview-search-reveal'

function setup() {
  const root = document.createElement('div')
  const input = document.createElement('input')
  root.append(input)
  const client = new MarkdownPreviewDocumentClient(
    { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null },
    vi.fn()
  )
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 2,
    getScrollElement: () => root,
    estimateSize: () => 100,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
    initialRect: { width: 100, height: 100 }
  })
  const scroll = vi.spyOn(virtualizer, 'scrollToIndex')
  const options = {
    client,
    blocks: null,
    components: {},
    viewportReady: false,
    rootRef: { current: root },
    bodyRef: { current: root },
    virtualizer,
    scrollMarks: createProgrammaticScrollMarks(),
    searchInstance: {}
  }
  const initialProps: { activeMatch: MarkdownPreviewDocumentMatch | undefined; query: string } = {
    activeMatch: undefined,
    query: 'needle'
  }
  const hook = renderHook(
    ({
      activeMatch,
      query
    }: {
      activeMatch: MarkdownPreviewDocumentMatch | undefined
      query: string
    }) => useMarkdownPreviewSearchReveal({ ...options, activeMatch, query }),
    { initialProps }
  )
  return { ...hook, root, input, scroll, client }
}

afterEach(() => vi.unstubAllGlobals())

describe('virtual Find navigation ownership', () => {
  it.each(['wheel', 'touchmove', 'pointerdown', 'keydown'])(
    'lets %s input cancel a result before worker blocks arrive, while Next still works',
    (type) => {
      const { root, scroll, rerender, unmount, client } = setup()
      act(() =>
        root.dispatchEvent(
          type === 'keydown'
            ? new KeyboardEvent(type, { key: 'PageDown', bubbles: true })
            : new Event(type, { bubbles: true })
        )
      )
      const first = { block: 0, occurrence: 0 }
      rerender({ activeMatch: first, query: 'needle' })
      expect(scroll).not.toHaveBeenCalled()
      rerender({ activeMatch: { block: 1, occurrence: 0 }, query: 'needle' })
      expect(scroll).toHaveBeenCalledExactlyOnceWith(1, { align: 'center' })
      unmount()
      client.close()
    }
  )

  it('lets explicit Next reveal a single match after its initial result was cancelled', () => {
    const { root, scroll, rerender, result, unmount, client } = setup()
    act(() => root.dispatchEvent(new Event('wheel')))
    rerender({ activeMatch: { block: 0, occurrence: 0 }, query: 'needle' })
    expect(scroll).not.toHaveBeenCalled()
    act(() => result.current())
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, { align: 'center' })
    unmount()
    client.close()
  })

  it('keeps query editing independent of viewport scroll input and cleans up listeners', () => {
    const { root, input, scroll, rerender, unmount, client } = setup()
    const remove = vi.spyOn(root, 'removeEventListener')
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    rerender({ activeMatch: { block: 1, occurrence: 0 }, query: 'needle' })
    expect(scroll).toHaveBeenCalledExactlyOnceWith(1, { align: 'center' })
    unmount()
    for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
      expect(remove.mock.calls.some(([name]) => name === type)).toBe(true)
    }
    client.close()
  })
})

describe('Find ranges after rendered content changes', () => {
  it('repaints replaced code without taking navigation back from manual scrolling', () => {
    const registry = new Map<string, Set<Range>>()
    vi.stubGlobal('CSS', { highlights: registry })
    vi.stubGlobal('Highlight', Set)
    const root = document.createElement('div')
    const block = document.createElement('div')
    block.dataset.previewBlockIndex = '0'
    const code = document.createElement('code')
    code.textContent = 'const needle = 42'
    block.append(code)
    root.append(block)
    const client = new MarkdownPreviewDocumentClient(
      { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null },
      vi.fn()
    )
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 1,
      getScrollElement: () => root,
      estimateSize: () => 100,
      scrollToFn: () => {},
      observeElementRect: () => () => {},
      observeElementOffset: () => () => {},
      initialRect: { width: 100, height: 400 }
    })
    vi.spyOn(virtualizer, 'scrollToIndex').mockImplementation(() => {})
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 400))
    const bounds = vi.spyOn(Range.prototype, 'getBoundingClientRect')
    bounds.mockReturnValue(new DOMRect(0, 120, 80, 20))
    const scroll = vi.spyOn(root, 'scrollTo').mockImplementation(() => {})
    const options = {
      client,
      activeMatch: { block: 0, occurrence: 0 },
      query: 'const needle',
      blocks: [],
      viewportReady: true,
      rootRef: { current: root },
      bodyRef: { current: root },
      virtualizer,
      scrollMarks: createProgrammaticScrollMarks(),
      searchInstance: {}
    }
    const { rerender, unmount } = renderHook(
      ({ components }) => useMarkdownPreviewSearchReveal({ ...options, components }),
      { initialProps: { components: {} } }
    )
    const before = [...(registry.get('markdown-preview-search-active-match') ?? [])][0]
    expect(before?.toString()).toBe('const needle')
    act(() => root.dispatchEvent(new Event('wheel')))
    const replacement = document.createElement('code')
    replacement.textContent = code.textContent
    code.replaceWith(replacement)
    rerender({ components: {} })
    const after = [...(registry.get('markdown-preview-search-active-match') ?? [])][0]
    expect(after?.toString()).toBe('const needle')
    expect(after?.startContainer).toBe(replacement.firstChild)
    expect(after).not.toBe(before)
    expect(scroll).toHaveBeenCalledOnce()
    unmount()
    client.close()
    bounds.mockRestore()
  })
})

describe('exact Find positioning', () => {
  it.each([0, 1000])(
    'reveals the exact match in a tall code block at horizontal offset %i',
    (left) => {
      const root = document.createElement('div')
      const block = document.createElement('div')
      block.dataset.previewBlockIndex = '0'
      const code = document.createElement('code')
      code.textContent = `${'prefix\n'.repeat(900)}needle`
      const pre = document.createElement('pre')
      pre.append(code)
      block.append(pre)
      root.append(block)
      const client = new MarkdownPreviewDocumentClient(
        { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null },
        vi.fn()
      )
      const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
        count: 1,
        getScrollElement: () => root,
        estimateSize: () => 5000,
        scrollToFn: () => {},
        observeElementRect: () => () => {},
        observeElementOffset: () => () => {},
        initialRect: { width: 100, height: 600 }
      })
      vi.spyOn(virtualizer, 'scrollToIndex').mockImplementation(() => {})
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 100, 600))
      vi.spyOn(code, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 100, 5000))
      vi.spyOn(pre, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 100, 600))
      const horizontalScroll = vi.spyOn(pre, 'scrollTo').mockImplementation(() => {})
      const rangeBounds = vi.spyOn(Range.prototype, 'getBoundingClientRect')
      rangeBounds.mockReturnValue(new DOMRect(left, 4900, 50, 20))
      const scroll = vi.spyOn(root, 'scrollTo').mockImplementation(() => {})
      const options = {
        client,
        components: {},
        activeMatch: { block: 0, occurrence: 0 },
        query: 'needle',
        viewportReady: true,
        rootRef: { current: root },
        bodyRef: { current: root },
        virtualizer,
        scrollMarks: createProgrammaticScrollMarks(),
        searchInstance: {}
      }
      const { rerender, unmount } = renderHook(
        ({ blocks }) => useMarkdownPreviewSearchReveal({ ...options, blocks }),
        { initialProps: { blocks: [] } }
      )
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 4510 })
      if (left) {
        expect(horizontalScroll).toHaveBeenCalledExactlyOnceWith({ left: 950 })
      } else {
        expect(horizontalScroll).not.toHaveBeenCalled()
      }
      rangeBounds.mockReturnValue(new DOMRect(0, 390, 50, 20))
      rerender({ blocks: [] })
      rerender({ blocks: [] })
      expect(scroll).toHaveBeenCalledTimes(1)
      unmount()
      client.close()
      rangeBounds.mockRestore()
    }
  )
})
