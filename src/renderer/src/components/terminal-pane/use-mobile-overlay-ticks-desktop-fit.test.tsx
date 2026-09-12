// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { hydrateOverrides, setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { useMobileOverlayTicks } from './use-mobile-overlay-ticks'

type TestPane = {
  id: number
  terminal: {
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
      fit: vi.fn(),
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
  })

  function mountForPane(pane: TestPane): void {
    const managerRef = {
      current: { getPanes: () => [pane] } as unknown as PaneManager
    }
    const paneTransportsRef = {
      current: new Map([[1, { getPtyId: () => 'pty-1' }]])
    }
    render(<HookHost managerRef={managerRef} paneTransportsRef={paneTransportsRef} />)
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
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 19)
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
})
