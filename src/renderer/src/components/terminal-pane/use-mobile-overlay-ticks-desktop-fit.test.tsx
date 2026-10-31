// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
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

  it.each(['unmount', 'rebind', 'retirement', 'manager replacement', 'new phone hold'] as const)(
    'drops replay-deferred restore after %s',
    async (transition) => {
      const pane = createPane()
      const binding = mountForPane(pane)
      beginTerminalScrollIntentBufferRebuild(pane.terminal)
      act(() => setFitOverride('pty-1', 'desktop-fit', 120, 40))
      flushAnimationFrames()
      act(() => vi.advanceTimersByTime(100))
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
      expect(pane.terminal.cols).toBe(49)
      expect(pane.terminal.refresh).not.toHaveBeenCalled()
      expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    }
  )

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
