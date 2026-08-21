import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import {
  installTerminalLinkifierHoverResetOnMouseLeave,
  installTerminalLinkifierHoverResetOnWindowBlur
} from './terminal-linkifier-hover-reset-on-mouseleave'

type FakeLinkifier = {
  _lastBufferCell?: unknown
  _activeLine?: number
  _clearCurrentLink?: () => void
  _currentLink?: unknown
}

function createHarness(hasScreen = true) {
  let mouseLeaveHandler: (() => void) | null = null
  let blurHandler: (() => void) | null = null
  const addEventListener = vi.fn((_event: string, handler: () => void) => {
    if (_event === 'mouseleave') {
      mouseLeaveHandler = handler
    }
  })
  const removeEventListener = vi.fn((_event: string, handler: () => void) => {
    if (_event === 'mouseleave' && mouseLeaveHandler === handler) {
      mouseLeaveHandler = null
    }
  })
  const screen = { addEventListener, removeEventListener, classList: { remove: vi.fn() } }
  const querySelector = vi.fn(() => (hasScreen ? screen : null))
  const rendererWindow = {
    addEventListener: vi.fn((_event: string, handler: () => void) => {
      blurHandler = handler
    }),
    removeEventListener: vi.fn((_event: string, handler: () => void) => {
      if (blurHandler === handler) {
        blurHandler = null
      }
    })
  }
  const linkifier: FakeLinkifier = {
    _lastBufferCell: { x: 2, y: 3 },
    _activeLine: 3,
    _clearCurrentLink: vi.fn(),
    _currentLink: { link: 'https://example.com' }
  }
  const terminal = {
    element: { querySelector, ownerDocument: { defaultView: rendererWindow } },
    _core: { linkifier }
  } as unknown as Terminal
  const linkTooltip = {
    ownerDocument: { defaultView: rendererWindow },
    style: { display: '' }
  } as unknown as HTMLElement
  return {
    terminal,
    linkifier,
    linkTooltip,
    rendererWindow,
    querySelector,
    addEventListener,
    removeEventListener,
    dispatchMouseLeave: () => mouseLeaveHandler?.(),
    dispatchBlur: () => blurHandler?.()
  }
}

describe('installTerminalLinkifierHoverResetOnMouseLeave', () => {
  it('resets the hover cache when the terminal surface loses the pointer', () => {
    const harness = createHarness()
    installTerminalLinkifierHoverResetOnMouseLeave(harness.terminal, harness.linkTooltip)

    expect(harness.querySelector).toHaveBeenCalledWith('.xterm-screen')
    expect(harness.addEventListener).toHaveBeenCalledWith('mouseleave', expect.any(Function))
    harness.dispatchMouseLeave()

    expect(harness.linkifier._lastBufferCell).toBeUndefined()
    expect(harness.linkifier._activeLine).toBe(-1)
    expect(harness.linkifier._clearCurrentLink).toHaveBeenCalledTimes(1)
    expect(harness.linkifier._currentLink).toBeUndefined()
    expect(harness.linkTooltip.style.display).toBe('none')
  })

  it('removes the listener on dispose', () => {
    const harness = createHarness()
    const disposable = installTerminalLinkifierHoverResetOnMouseLeave(harness.terminal)
    const mouseLeaveHandler = harness.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'mouseleave'
    )?.[1]
    expect(mouseLeaveHandler).toBeTypeOf('function')

    disposable.dispose()
    expect(harness.removeEventListener).toHaveBeenCalledWith('mouseleave', mouseLeaveHandler)
    harness.dispatchMouseLeave()

    expect(harness.linkifier._lastBufferCell).toEqual({ x: 2, y: 3 })
    expect(harness.linkifier._activeLine).toBe(3)
  })

  it('degrades to a no-op when the screen is unavailable', () => {
    const harness = createHarness(false)

    expect(() =>
      installTerminalLinkifierHoverResetOnMouseLeave(harness.terminal).dispose()
    ).not.toThrow()
  })

  it('does not throw when xterm linkifier internals are unavailable', () => {
    const harness = createHarness()
    const terminal = harness.terminal as unknown as { _core?: unknown }
    terminal._core = undefined
    installTerminalLinkifierHoverResetOnMouseLeave(harness.terminal)

    expect(harness.dispatchMouseLeave).not.toThrow()
  })

  it('clears the active link and tooltip when the renderer window blurs', () => {
    const harness = createHarness()
    const disposable = installTerminalLinkifierHoverResetOnWindowBlur(
      harness.terminal,
      harness.linkTooltip
    )

    harness.dispatchBlur()

    expect(harness.rendererWindow.addEventListener).toHaveBeenCalledWith(
      'blur',
      expect.any(Function)
    )
    expect(harness.linkifier._clearCurrentLink).toHaveBeenCalledTimes(1)
    expect(harness.linkifier._currentLink).toBeUndefined()
    expect(harness.linkifier._lastBufferCell).toBeUndefined()
    expect(harness.linkifier._activeLine).toBe(-1)
    expect(harness.linkTooltip.style.display).toBe('none')

    disposable.dispose()
    expect(harness.rendererWindow.removeEventListener).toHaveBeenCalledWith(
      'blur',
      expect.any(Function)
    )
  })
})
