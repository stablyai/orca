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
    expect(html).not.toContain('payments-api')
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('animate-cmd-j-tip-caret')
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

  it('settles after the one-shot demo instead of looping idle timers', async () => {
    vi.useFakeTimers()

    const { container, root } = await renderVisual()
    await act(async () => {
      vi.runAllTimers()
    })

    expect(container.textContent).toContain('auth')
    expect(container.textContent).toContain('auth-redirect')
    expect(container.textContent).not.toContain('payments-api')
    expect(vi.getTimerCount()).toBe(0)

    await act(async () => {
      root.unmount()
    })
  })

  it('does not render infinite animation classes in the default preview', () => {
    const html = renderToStaticMarkup(<CmdJPaletteFeatureTipVisual />)

    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('animate-cmd-j-tip-caret')
  })

  it('falls back to default per-key chips when the live binding is unassigned', () => {
    shortcutKeysMock.mockReturnValue([])
    formatShortcutKeysMock.mockReturnValue(['Ctrl', 'Shift', 'J'])

    const html = renderToStaticMarkup(<CmdJPaletteFeatureTipVisual />)

    expect(formatShortcutKeysMock).toHaveBeenCalledWith('worktree.palette')
    expect(html).toContain('Ctrl')
    expect(html).toContain('Shift')
    expect(html).toContain('J')
  })

  it('shows the create-worktree row only once the demo query is non-empty', () => {
    prefersReducedMotionMock.mockReturnValue(true)
    const html = renderToStaticMarkup(<CmdJPaletteFeatureTipVisual />)

    expect(html).toContain('Create worktree')
    expect(html).toContain('auth')
  })

  it('renders the live binding as separate shortcut key chips with plus separators', () => {
    shortcutKeysMock.mockReturnValue(['⌘', 'J'])

    const html = renderToStaticMarkup(<CmdJPaletteFeatureTipVisual />)

    expect(html).toContain('⌘')
    expect(html).toContain('J')
    expect(html).toContain('+')
  })
})
