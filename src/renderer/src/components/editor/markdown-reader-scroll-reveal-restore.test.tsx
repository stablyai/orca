// @vitest-environment happy-dom
//
// Regression guard for #24667: on macOS the OS can drop an occluded window's
// scroll position (container reads scrollTop 0 after reveal) and nothing
// re-anchored it because restore only ran on mount/content change. The markdown
// reader's scroll hooks must (a) flush the debounced save on window blur so the
// cache always matches the hidden DOM, and (b) re-apply the cached position on
// window reveal when the container lost it.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollTopCache } from '@/lib/scroll-cache'
import { useEditorScrollRestore } from './useEditorScrollRestore'
import { useMarkdownPreviewScrollViewport } from './use-markdown-preview-scroll-viewport'

function withScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

type HarnessProps = {
  containerRef: React.RefObject<HTMLDivElement | null>
  scrollCacheKey: string
  renderedContent: string
}

function PreviewHarness({ containerRef, scrollCacheKey, renderedContent }: HarnessProps) {
  useMarkdownPreviewScrollViewport({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only reads { rootRef, renderedContent } from the foundation, so the harness supplies a partial object asserted to the full foundation shape.
    foundation: { rootRef: containerRef, renderedContent } as Parameters<
      typeof useMarkdownPreviewScrollViewport
    >[0]['foundation'],
    scrollCacheKey
  })
  return <div ref={containerRef} data-testid="reader-viewport" />
}

function RichHarness({ containerRef, scrollCacheKey }: HarnessProps) {
  useEditorScrollRestore(containerRef, scrollCacheKey, null)
  return <div ref={containerRef} data-testid="reader-viewport" />
}

const HARNESS_CASES = [
  { name: 'MarkdownPreview viewport', Harness: PreviewHarness },
  { name: 'RichMarkdownEditor viewport', Harness: RichHarness }
] as const

describe.each(HARNESS_CASES)('$name reveal restore', ({ Harness }) => {
  let root: Root
  let host: HTMLDivElement
  const scrollCacheKey = 'reveal-restore-key'

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame']
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    scrollTopCache.clear()
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    vi.useRealTimers()
    scrollTopCache.clear()
  })

  async function mountHarness(): Promise<HTMLDivElement> {
    const containerRef: React.RefObject<HTMLDivElement | null> = { current: null }
    await act(async () => {
      root.render(
        <Harness
          containerRef={containerRef}
          scrollCacheKey={scrollCacheKey}
          renderedContent="doc"
        />
      )
    })
    const container = host.querySelector<HTMLDivElement>('[data-testid="reader-viewport"]')
    expect(container).not.toBeNull()
    withScrollMetrics(container!, 5000, 500)
    return container!
  }

  it('re-applies the cached scroll position when the window regains focus after a loss', async () => {
    const container = await mountHarness()

    act(() => {
      container.scrollTop = 1200
      container.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(scrollTopCache.get(scrollCacheKey)).toBe(1200)

    // the OS drops the occluded window's position while hidden
    act(() => {
      container.scrollTop = 0
    })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(container.scrollTop).toBe(1200)
  })

  it('re-applies the cached position when the document turns visible again', async () => {
    const container = await mountHarness()

    act(() => {
      container.scrollTop = 900
      container.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    act(() => {
      container.scrollTop = 0
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(container.scrollTop).toBe(900)
  })

  it('flushes the debounced save on window blur so a fast scroll-then-switch keeps its position', async () => {
    const container = await mountHarness()

    act(() => {
      container.scrollTop = 700
      container.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('blur'))
    })
    expect(scrollTopCache.get(scrollCacheKey)).toBe(700)
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(scrollTopCache.get(scrollCacheKey)).toBe(700)
  })

  it('keeps the blur-time snapshot when a hidden-period scroll re-arms the debounce before reveal', async () => {
    const container = await mountHarness()

    act(() => {
      container.scrollTop = 1200
      container.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(scrollTopCache.get(scrollCacheKey)).toBe(1200)

    // hidden: the OS drops the position and a layout-induced scroll re-arms the debounce
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    try {
      act(() => {
        container.scrollTop = 0
        container.dispatchEvent(new Event('scroll'))
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      expect(scrollTopCache.get(scrollCacheKey)).toBe(1200)

      act(() => {
        window.dispatchEvent(new Event('focus'))
      })
      expect(container.scrollTop).toBe(1200)
    } finally {
      Reflect.deleteProperty(document, 'hidden')
    }
  })

  it('re-anchors from the pending visible snapshot when focus fires before the throttled save', async () => {
    const container = await mountHarness()

    act(() => {
      container.scrollTop = 1200
      container.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    // a newer visible scroll arms the throttle, then the OS drops the position
    // before the 150 ms save runs: reveal must anchor from that pending
    // snapshot, not the stale cached entry
    act(() => {
      container.scrollTop = 1500
      container.dispatchEvent(new Event('scroll'))
      container.scrollTop = 0
      window.dispatchEvent(new Event('focus'))
    })
    expect(container.scrollTop).toBe(1500)
    expect(scrollTopCache.get(scrollCacheKey)).toBe(1500)

    // the reveal flush consumed the timer; the later tick and blur must not
    // resurrect stale data
    await act(async () => {
      vi.advanceTimersByTime(300)
      window.dispatchEvent(new Event('blur'))
    })
    expect(container.scrollTop).toBe(1500)
    expect(scrollTopCache.get(scrollCacheKey)).toBe(1500)
  })

  it('re-anchors from the pending visible snapshot when visibility turns before the throttled save', async () => {
    const container = await mountHarness()

    act(() => {
      container.scrollTop = 1200
      container.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    act(() => {
      container.scrollTop = 1500
      container.dispatchEvent(new Event('scroll'))
      container.scrollTop = 0
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(container.scrollTop).toBe(1500)
    expect(scrollTopCache.get(scrollCacheKey)).toBe(1500)
  })

  it('saves the last visible position when the throttled save fires after the window was hidden', async () => {
    const container = await mountHarness()

    act(() => {
      container.scrollTop = 1200
      container.dispatchEvent(new Event('scroll'))
    })
    // the window is occluded before the 150 ms throttle elapses; the OS then
    // drops the container's position, so a hidden-time read is useless
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    try {
      act(() => {
        container.scrollTop = 0
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      expect(scrollTopCache.get(scrollCacheKey)).toBe(1200)

      // blur finds no pending timer anymore; the visible snapshot is already saved
      act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      expect(scrollTopCache.get(scrollCacheKey)).toBe(1200)

      act(() => {
        window.dispatchEvent(new Event('focus'))
      })
      expect(container.scrollTop).toBe(1200)
    } finally {
      Reflect.deleteProperty(document, 'hidden')
    }
  })

  it('stays idle without a cache and never overrides live or deliberately-top positions', async () => {
    const container = await mountHarness()

    // no cache for this key yet: focus must not scroll anywhere
    act(() => {
      container.scrollTop = 0
      window.dispatchEvent(new Event('focus'))
    })
    expect(container.scrollTop).toBe(0)

    // user is at a live position: focus must not move it
    act(() => {
      container.scrollTop = 400
      container.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(container.scrollTop).toBe(400)

    // user scrolled back to top deliberately (cache caught up): focus stays at top
    act(() => {
      container.scrollTop = 0
      container.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(container.scrollTop).toBe(0)
  })
})
