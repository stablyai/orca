// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CmdJPaletteFeatureTipVisual } from './CmdJPaletteFeatureTipVisual'

const prefersReducedMotionMock = vi.hoisted(() => vi.fn(() => false))
const shortcutKeysMock = vi.hoisted(() => vi.fn(() => ['⌘', 'J']))
const formatShortcutKeysMock = vi.hoisted(() => vi.fn(() => ['⌘', 'J']))

vi.mock('@/components/feature-wall/feature-wall-modal-helpers', () => ({
  usePrefersReducedMotion: prefersReducedMotionMock
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeys: shortcutKeysMock,
  formatShortcutKeys: formatShortcutKeysMock
}))

async function renderVisual(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(<CmdJPaletteFeatureTipVisual />)
  })

  return { container, root }
}

describe('CmdJPaletteFeatureTipVisual', () => {
  beforeEach(() => {
    prefersReducedMotionMock.mockReturnValue(false)
    shortcutKeysMock.mockReturnValue(['⌘', 'J'])
    formatShortcutKeysMock.mockReturnValue(['⌘', 'J'])
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('renders the static end state without motion classes when reduced motion is preferred', () => {
    prefersReducedMotionMock.mockReturnValue(true)

    const html = renderToStaticMarkup(<CmdJPaletteFeatureTipVisual />)

    expect(html).toContain('auth')
    expect(html).toContain('auth-redirect')
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('animate-cmd-j-tip-result-in')
  })

  it('does not schedule animation timers when reduced motion is preferred', async () => {
    prefersReducedMotionMock.mockReturnValue(true)
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')

    const { root } = await renderVisual()
    await act(async () => {
      root.unmount()
    })

    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('clears pending timers on unmount', async () => {
    vi.useFakeTimers()
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')

    const { root } = await renderVisual()
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await act(async () => {
      root.unmount()
    })

    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('falls back to default shortcut keys when the live binding is disabled', () => {
    shortcutKeysMock.mockReturnValue([])

    const html = renderToStaticMarkup(<CmdJPaletteFeatureTipVisual />)

    expect(formatShortcutKeysMock).toHaveBeenCalledWith('worktree.palette')
    expect(html).toContain('⌘')
    expect(html).toContain('J')
  })
})
