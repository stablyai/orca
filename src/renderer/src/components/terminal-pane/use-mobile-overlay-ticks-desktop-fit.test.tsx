// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Terminal } from '@xterm/headless'
import { hydrateOverrides, setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport-types'
import { useMobileOverlayTicks } from './use-mobile-overlay-ticks'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild
} from '@/lib/pane-manager/terminal-scroll-intent-rebuild'

type TestPane = {
  id: number
  terminal: {
    buffer: { active: { type: 'normal'; viewportY: number; baseY: number } }
    cols: number
    rows: number
    refresh: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
  }
  container: {
    dataset: Record<string, string>
    getBoundingClientRect: () => { width: number; height: number }
  }
  fitAddon: {
    fit: ReturnType<typeof vi.fn>
    proposeDimensions: ReturnType<typeof vi.fn>
  }
}

function createPane(): TestPane {
  const terminal = {
    buffer: { active: { type: 'normal' as const, viewportY: 0, baseY: 0 } },
    cols: 49,
    rows: 20,
    refresh: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      terminal.cols = cols
      terminal.rows = rows
    })
  }
  return {
    id: 1,
    terminal,
    container: {
      dataset: { ptyId: 'pty-1' },
      getBoundingClientRect: () => ({ width: 800, height: 600 })
    },
    fitAddon: {
      fit: vi.fn(() => {
        terminal.cols = 120
        terminal.rows = 40
      }),
      proposeDimensions: vi.fn(() => ({ cols: 120, rows: 40 }))
    }
  }
}

function HookHost({
  managerRef,
  paneTransportsRef
}: {
  managerRef: { current: PaneManager | null }
  paneTransportsRef: { current: ReadonlyMap<number, Pick<PtyTransport, 'getPtyId'>> }
}): null {
  useMobileOverlayTicks({ managerRef, paneTransportsRef })
  return null
}

describe('useMobileOverlayTicks desktop-fit restore', () => {
  let rafQueue: FrameRequestCallback[]

  function flushAnimationFrames(): void {
    const queued = rafQueue
    rafQueue = []
    act(() => {
      for (const callback of queued) {
        callback(16)
      }
    })
  }

  beforeEach(() => {
    rafQueue = []
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafQueue.push(callback)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    cleanup()
    hydrateOverrides([])
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function mountForPane(pane: TestPane) {
    let currentPanes = [pane]
    const managerRef: { current: PaneManager | null } = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only reads getPanes; safeFit reads the fixture's pane members.
      current: {
        getPanes: () => currentPanes.map((current) => ({ ...current }))
      } as unknown as PaneManager
    }
    const paneTransportsRef: { current: ReadonlyMap<number, Pick<PtyTransport, 'getPtyId'>> } = {
      current: new Map([[1, { getPtyId: () => 'pty-1' }]])
    }
    const view = render(<HookHost managerRef={managerRef} paneTransportsRef={paneTransportsRef} />)
    return {
      managerRef,
      paneTransportsRef,
      unmount: view.unmount,
      setPanes: (panes: TestPane[]) => {
        currentPanes = panes
      }
    }
  }

  it('refits and refreshes when mobile-fit is released, not only resize bookkeeping', () => {
    const pane = createPane()
    mountForPane(pane)

    act(() => {
      setFitOverride('pty-1', 'mobile-fit', 49, 20)
    })
    flushAnimationFrames()
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).not.toHaveBeenCalled()

    act(() => {
      setFitOverride('pty-1', 'desktop-fit', 120, 40)
    })
    flushAnimationFrames()

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 39)
  })

  it('fits a released shared grid before cursor-addressed redraw bytes without waiting for a frame', async () => {
    const terminal = new Terminal({ cols: 94, rows: 56, allowProposedApi: true })
    const pane = createPane()
    Object.defineProperties(pane.terminal, {
      cols: { get: () => terminal.cols },
      rows: { get: () => terminal.rows },
      buffer: { get: () => terminal.buffer }
    })
    pane.terminal.resize.mockImplementation((cols, rows) => terminal.resize(cols, rows))
    pane.fitAddon.proposeDimensions.mockReturnValue({ cols: 137, rows: 64 })
    pane.fitAddon.fit.mockImplementation(() => pane.terminal.resize(137, 64))
    const binding = mountForPane(pane)
    try {
      act(() => setFitOverride('pty-1', 'remote-desktop-fit', 94, 56, true))
      expect(terminal.cols).toBe(94)
      expect(terminal.rows).toBe(56)

      act(() => setFitOverride('pty-1', 'desktop-fit', 137, 64))
      expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
      expect(terminal.cols).toBe(137)
      expect(terminal.rows).toBe(64)
      expect(rafQueue.length).toBeGreaterThan(0)

      let parsed = false
      terminal.write(
        '\x1b[?1049h\x1b[2J\x1b[HFRAME\x1b[4;128HRIGHT_EDGE\x1b[64;1HBOTTOM_EDGE\x1b[6;9H',
        () => {
          parsed = true
        }
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(parsed).toBe(true)
      expect(terminal.buffer.active.type).toBe('alternate')
      expect(terminal.buffer.active.getLine(3)?.translateToString(true)).toBe(
        `${' '.repeat(127)}RIGHT_EDGE`
      )
      expect(terminal.buffer.active.getLine(63)?.translateToString(true)).toBe('BOTTOM_EDGE')
      expect(terminal.buffer.active.cursorX).toBe(8)
      expect(terminal.buffer.active.cursorY).toBe(5)
    } finally {
      binding.unmount()
      terminal.dispose()
    }
  })

  it('does not refresh while applying a mobile-fit hold', () => {
    const pane = createPane()
    pane.terminal.cols = 120
    pane.terminal.rows = 40
    mountForPane(pane)

    act(() => {
      setFitOverride('pty-1', 'mobile-fit', 49, 20)
    })
    flushAnimationFrames()

    expect(pane.terminal.resize).toHaveBeenCalledWith(49, 20)
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })

  it('fits the latest phone dimensions when an older mobile frame survives an ownership cycle', () => {
    const pane = createPane()
    pane.terminal.cols = 120
    pane.terminal.rows = 40
    mountForPane(pane)
    act(() => {
      setFitOverride('pty-1', 'mobile-fit', 49, 20)
      setFitOverride('pty-1', 'desktop-fit', 120, 40)
      setFitOverride('pty-1', 'mobile-fit', 60, 24)
    })
    flushAnimationFrames()
    act(() => vi.advanceTimersByTime(100))
    expect(pane.terminal.cols).toBe(60)
    expect(pane.terminal.rows).toBe(24)
    expect(pane.terminal.resize).not.toHaveBeenCalledWith(49, 20)
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })

  it('does not fit a retired manager after its transport and pane teardown', () => {
    const pane = createPane()
    pane.terminal.cols = 120
    pane.terminal.rows = 40
    const binding = mountForPane(pane)
    act(() => setFitOverride('pty-1', 'mobile-fit', 49, 20))
    binding.paneTransportsRef.current = new Map()
    binding.setPanes([])
    binding.managerRef.current = null
    flushAnimationFrames()
    expect(pane.terminal.cols).toBe(120)
    expect(pane.terminal.rows).toBe(40)
    expect(pane.terminal.resize).not.toHaveBeenCalled()
  })

  it('abandons the desktop restore when a new phone hold arrives before the frame', () => {
    const pane = createPane()
    mountForPane(pane)
    act(() => {
      setFitOverride('pty-1', 'mobile-fit', 49, 20)
      setFitOverride('pty-1', 'desktop-fit', 120, 40)
      setFitOverride('pty-1', 'mobile-fit', 49, 20)
    })
    flushAnimationFrames()
    act(() => vi.advanceTimersByTime(100))
    expect(pane.terminal.cols).toBe(49)
    expect(pane.terminal.rows).toBe(20)
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('drops both queued restore paths when the manager is replaced', () => {
    const pane = createPane()
    const { managerRef } = mountForPane(pane)
    act(() => setFitOverride('pty-1', 'desktop-fit', 120, 40))
    managerRef.current = null
    flushAnimationFrames()
    act(() => vi.advanceTimersByTime(100))
    expect(pane.terminal.cols).toBe(49)
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('uses only the latest restore dimensions after a complete phone ownership cycle', () => {
    const pane = createPane()
    pane.fitAddon.proposeDimensions.mockReturnValue(null)
    pane.fitAddon.fit.mockImplementation(() => {})
    mountForPane(pane)
    act(() => {
      setFitOverride('pty-1', 'mobile-fit', 49, 20)
      setFitOverride('pty-1', 'desktop-fit', 120, 40)
      setFitOverride('pty-1', 'mobile-fit', 49, 20)
      setFitOverride('pty-1', 'desktop-fit', 140, 50)
    })
    flushAnimationFrames()
    act(() => vi.advanceTimersByTime(100))
    expect(pane.terminal.cols).toBe(140)
    expect(pane.terminal.rows).toBe(50)
    expect(pane.terminal.resize).not.toHaveBeenCalledWith(120, 40)
  })

  it.each(
    (['desktop-fit', 'shared-grid release'] as const).flatMap((restore) =>
      (['unmount', 'rebind', 'retirement', 'manager replacement', 'new phone hold'] as const).map(
        (transition) => ({ restore, transition })
      )
    )
  )('drops replay-deferred $restore after $transition', async ({ restore, transition }) => {
    const pane = createPane()
    const binding = mountForPane(pane)
    if (restore === 'shared-grid release') {
      act(() => setFitOverride('pty-1', 'remote-desktop-fit', 49, 20, true))
      pane.terminal.refresh.mockClear()
    }
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    act(() => setFitOverride('pty-1', 'desktop-fit', 120, 40))
    if (restore === 'desktop-fit') {
      flushAnimationFrames()
      act(() => vi.advanceTimersByTime(100))
    }
    if (transition === 'unmount') {
      binding.unmount()
    } else if (transition === 'retirement') {
      binding.setPanes([])
    } else if (transition === 'manager replacement') {
      binding.managerRef.current = null
    } else if (transition === 'rebind') {
      binding.paneTransportsRef.current = new Map([[1, { getPtyId: () => 'pty-2' }]])
    } else {
      act(() => setFitOverride('pty-1', 'mobile-fit', 49, 20))
    }
    endTerminalScrollIntentBufferRebuild(pane.terminal)
    await act(async () => {
      await Promise.resolve()
    })
    flushAnimationFrames()
    act(() => vi.advanceTimersByTime(100))
    expect(pane.terminal.cols).toBe(49)
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('does not restore a replacement terminal that reused a pane id during replay', async () => {
    const pane = createPane()
    const replacement = createPane()
    const binding = mountForPane(pane)
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    act(() => setFitOverride('pty-1', 'desktop-fit', 120, 40))
    flushAnimationFrames()
    act(() => vi.advanceTimersByTime(100))
    binding.setPanes([replacement])
    endTerminalScrollIntentBufferRebuild(pane.terminal)
    await act(async () => {
      await Promise.resolve()
    })
    expect(pane.terminal.cols).toBe(49)
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
    expect(replacement.terminal.cols).toBe(49)
    expect(replacement.terminal.refresh).not.toHaveBeenCalled()
  })
})
