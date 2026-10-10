// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_EXPLORER_SCROLLING_ATTR,
  FILE_EXPLORER_SCROLL_HOVER_IDLE_MS,
  bindFileExplorerScrollHover
} from './file-explorer-scroll-hover'

const here = import.meta.dirname

afterEach(() => {
  vi.useRealTimers()
})

describe('file explorer scroll hover', () => {
  it('ignores row hover while the viewport is scrolling and restores it after idle', () => {
    vi.useFakeTimers()
    const container = document.createElement('div')
    const unbind = bindFileExplorerScrollHover(container)

    container.dispatchEvent(new Event('scroll'))
    expect(container.hasAttribute(FILE_EXPLORER_SCROLLING_ATTR)).toBe(true)

    vi.advanceTimersByTime(FILE_EXPLORER_SCROLL_HOVER_IDLE_MS - 1)
    expect(container.hasAttribute(FILE_EXPLORER_SCROLLING_ATTR)).toBe(true)

    vi.advanceTimersByTime(1)
    expect(container.hasAttribute(FILE_EXPLORER_SCROLLING_ATTR)).toBe(false)
    unbind()
  })

  it('restarts the idle wait when another scroll arrives', () => {
    vi.useFakeTimers()
    const container = document.createElement('div')
    const unbind = bindFileExplorerScrollHover(container)

    container.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(FILE_EXPLORER_SCROLL_HOVER_IDLE_MS - 1)
    container.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(FILE_EXPLORER_SCROLL_HOVER_IDLE_MS - 1)
    expect(container.hasAttribute(FILE_EXPLORER_SCROLLING_ATTR)).toBe(true)

    vi.advanceTimersByTime(1)
    expect(container.hasAttribute(FILE_EXPLORER_SCROLLING_ATTR)).toBe(false)
    unbind()
  })

  it('drops the marker and the listener when the explorer unmounts', () => {
    vi.useFakeTimers()
    const container = document.createElement('div')
    const unbind = bindFileExplorerScrollHover(container)

    container.dispatchEvent(new Event('scroll'))
    unbind()
    expect(container.hasAttribute(FILE_EXPLORER_SCROLLING_ATTR)).toBe(false)

    container.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(FILE_EXPLORER_SCROLL_HOVER_IDLE_MS)
    expect(container.hasAttribute(FILE_EXPLORER_SCROLLING_ATTR)).toBe(false)
  })

  it('pairs the scrolling attribute with the row hover rule', () => {
    const css = readFileSync(join(here, '../../assets/main.css'), 'utf8')
    expect(css).toContain(
      `[${FILE_EXPLORER_SCROLLING_ATTR}] [data-file-explorer-row] {\n  pointer-events: none;`
    )
  })
})
