// @vitest-environment happy-dom

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { useAppStore } from '../../store'
import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from './native-chat-autoscroll'
import { transcriptRowOffset } from './native-chat-window-test-layout'
import {
  deliverResizes,
  layout,
  list,
  marker,
  scrollTranscript,
  stubLayout,
  stubResizeObserver,
  windowState
} from './native-chat-windowing-test-harness'

vi.mock('./NativeChatInlineVisual', () => ({ NativeChatInlineVisual: () => null }))
vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender: vi.fn() }))
vi.mock('./use-native-chat-paced-text', async (importOriginal) =>
  (await import('./native-chat-unpaced-text-fixture')).unpacedTextModule(importOriginal)
)

const messages = Array.from({ length: 100 }, (_, index) => ({
  ...marker(index),
  blocks: [{ type: 'text' as const, text: `marker-${index} ${'history '.repeat(65)}` }]
}))
const settings = createGlobalSettingsFixture({ appFontFamily: 'Geist' })

function scrollRoot(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
  if (!scroller) {
    throw new Error('no transcript scroll root')
  }
  return scroller
}

function paint(container: HTMLElement): void {
  const scroller = scrollRoot(container)
  // Commit-time scroll writes dispatch before the next ResizeObserver delivery.
  fireEvent.scroll(scroller)
  for (let pass = 0; pass < 30; pass += 1) {
    const previous = scroller.scrollTop
    let resized = false
    act(() => {
      resized = deliverResizes()
      vi.advanceTimersByTime(16)
    })
    const moved = scroller.scrollTop !== previous
    fireEvent.scroll(scroller)
    if (!resized && !moved && pass >= 2) {
      return
    }
  }
  throw new Error('transcript did not settle')
}

function readerAnchor(container: HTMLElement): { index: number; withinRow: number } {
  const top = scrollRoot(container).scrollTop
  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-index]')).find(
    (node) => transcriptRowOffset(node) + node.offsetHeight > top
  )
  if (!row) {
    throw new Error('no row at the reader offset')
  }
  return { index: Number(row.dataset.index), withinRow: top - transcriptRowOffset(row) }
}

function measureHistory(container: HTMLElement): void {
  for (let top = 0; top <= 10_000; top += 400) {
    scrollTranscript(container, top)
    paint(container)
  }
}

function changeFont(): void {
  act(() => {
    useAppStore.setState({
      settings: { ...settings, nativeChatAppearance: { fontFamily: 'Georgia' } }
    })
  })
}

describe('chat font changes in a windowed transcript', () => {
  let visible = true
  let restoreLayout = (): void => {}
  let restoreResizeObserver = (): void => {}
  const originalSettings = useAppStore.getState().settings

  beforeEach(() => {
    vi.useFakeTimers()
    visible = true
    layout.measuredRowHeights = Array(100).fill(80)
    restoreLayout = stubLayout({
      scrollGeometry: true,
      offsetChain: true,
      isVisible: () => visible
    })
    restoreResizeObserver = stubResizeObserver()
    useAppStore.setState({ settings })
  })
  afterEach(() => {
    cleanup()
    restoreResizeObserver()
    restoreLayout()
    layout.measuredRowHeights = []
    useAppStore.setState({ settings: originalSettings })
    vi.useRealTimers()
  })

  it.each([false, true])('retains the row and within-row offset (hidden: %s)', (hidden) => {
    const { container, rerender } = render(list(messages))
    paint(container)
    measureHistory(container)
    scrollTranscript(container, hidden ? 3_410 : 9_010)
    paint(container)
    const before = readerAnchor(container)
    expect(before).toEqual({ index: hidden ? 34 : 90, withinRow: 10 })
    expect(windowState(container).indexes.length).toBeLessThan(30)

    if (hidden) {
      visible = false
      rerender(list(messages, visible))
      paint(container)
      expect(scrollRoot(container).scrollTop).toBe(0)
    }
    changeFont()
    if (hidden) {
      visible = true
      rerender(list(messages, visible))
    }
    paint(container)

    expect(readerAnchor(container)).toEqual(before)
    expect(screen.queryByRole('button', { name: /jump to latest/i })).not.toBeNull()
    rerender(list([...messages, marker(100)]))
    paint(container)
    expect(readerAnchor(container)).toEqual(before)
  })

  it.each([false, true])(
    'keeps the row and offset with an unchanged family (hidden: %s)',
    (hidden) => {
      const { container, rerender } = render(list(messages))
      paint(container)
      measureHistory(container)
      scrollTranscript(container, 3_410)
      paint(container)
      const before = readerAnchor(container)
      if (hidden) {
        visible = false
        rerender(list(messages, visible))
        paint(container)
        visible = true
      }
      rerender(list(messages, visible))
      paint(container)
      expect(readerAnchor(container)).toEqual(before)
    }
  )

  it.each([
    { hidden: false, height: 40 },
    { hidden: false, height: 120 },
    { hidden: true, height: 40 },
    { hidden: true, height: 120 }
  ])(
    'remeasures mounted rows without moving a parked reader ($hidden, $height px)',
    ({ hidden, height }) => {
      const { container, rerender } = render(list(messages))
      paint(container)
      measureHistory(container)
      scrollTranscript(container, 3_410)
      paint(container)
      act(() => vi.advanceTimersByTime(200))
      const before = readerAnchor(container)
      const heightBefore = windowState(container).totalSize
      if (hidden) {
        visible = false
        rerender(list(messages, visible))
        paint(container)
      }
      layout.measuredRowHeights = Array(100).fill(height)
      changeFont()
      if (hidden) {
        visible = true
        rerender(list(messages, visible))
      }
      paint(container)

      expect(Math.sign(windowState(container).totalSize - heightBefore)).toBe(
        Math.sign(height - 80)
      )
      expect(readerAnchor(container)).toEqual(before)
    }
  )

  it('replaces offscreen cached heights when those rows remount after a font change', () => {
    const { container } = render(list(messages))
    paint(container)
    measureHistory(container)
    scrollTranscript(container, 3_410)
    paint(container)
    act(() => vi.advanceTimersByTime(200))
    layout.measuredRowHeights = Array(100).fill(120)
    changeFont()
    paint(container)
    const before = windowState(container)
    expect(before.indexes).not.toContain(5)

    scrollTranscript(container, 500)
    paint(container)
    const after = windowState(container)
    expect(after.indexes).toContain(5)
    expect(after.totalSize).toBeGreaterThan(before.totalSize)
    const row = container.querySelector<HTMLElement>('[data-index="5"]')
    const nextRow = container.querySelector<HTMLElement>('[data-index="6"]')
    if (!row || !nextRow) {
      throw new Error('remeasured rows are missing')
    }
    expect(transcriptRowOffset(nextRow) - transcriptRowOffset(row)).toBe(140)
  })

  it.each([false, true])(
    'remeasures font reflow and keeps following the end (hidden: %s)',
    (hidden) => {
      const { container, rerender } = render(list(messages))
      paint(container)
      if (hidden) {
        visible = false
        rerender(list(messages, visible))
        paint(container)
      }
      layout.measuredRowHeights = Array(100).fill(120)
      changeFont()
      if (hidden) {
        visible = true
        rerender(list(messages, visible))
      }
      paint(container)

      const scroller = scrollRoot(container)
      expect(
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
      ).toBeLessThanOrEqual(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
      expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull()
    }
  )
})
