import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { collectRendererMemoryProfileCounts } from '../renderer-memory-profile'
import { PaneManager } from './pane-manager'
import {
  forEachLivePaneForDesyncSentinel,
  getLivePaneCensus,
  getLiveTerminalBufferCensus,
  refitAndRefreshAllTerminalPanes,
  registerLivePaneManager,
  resetAndRefreshAllTerminalWebglAtlases,
  resetAllTerminalWebglAtlases,
  unregisterLivePaneManager
} from './pane-manager-registry'

describe('pane manager registry', () => {
  // Why: the registry is module-global; unregister in afterEach so a failed
  // assertion cannot leak fake managers into later tests.
  const registeredManagers: { resetWebglTextureAtlases(): void }[] = []

  function registerManager(): { resetWebglTextureAtlases: Mock<() => void> } {
    const manager = { resetWebglTextureAtlases: vi.fn<() => void>() }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    return manager
  }

  afterEach(() => {
    for (const manager of registeredManagers.splice(0)) {
      unregisterLivePaneManager(manager)
    }
  })

  it('resets atlases on every registered manager', () => {
    const first = registerManager()
    const second = registerManager()

    resetAllTerminalWebglAtlases()

    expect(first.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(second.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
  })

  it('stops resetting managers after they unregister', () => {
    const manager = registerManager()
    unregisterLivePaneManager(manager)

    resetAllTerminalWebglAtlases()

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
  })

  it('continues resetting later managers when one manager throws', () => {
    const broken = {
      resetWebglTextureAtlases: vi.fn<() => void>(() => {
        throw new Error('pane disposed')
      })
    }
    registerLivePaneManager(broken)
    registeredManagers.push(broken)
    const healthy = registerManager()

    expect(() => resetAllTerminalWebglAtlases()).not.toThrow()

    expect(broken.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(healthy.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
  })

  it('refreshes managers after all atlas resets complete', () => {
    const order: string[] = []
    const first = {
      resetWebglTextureAtlases: vi.fn<() => void>(() => order.push('first-reset')),
      refreshAllPanes: vi.fn<() => void>(() => order.push('first-refresh'))
    }
    const second = {
      resetWebglTextureAtlases: vi.fn<() => void>(() => order.push('second-reset')),
      refreshAllPanes: vi.fn<() => void>(() => order.push('second-refresh'))
    }
    registerLivePaneManager(first)
    registeredManagers.push(first)
    registerLivePaneManager(second)
    registeredManagers.push(second)

    resetAndRefreshAllTerminalWebglAtlases()

    expect(order).toEqual(['first-reset', 'second-reset', 'first-refresh', 'second-refresh'])
  })

  it('continues reset-and-refresh recovery when one manager throws', () => {
    const broken = {
      resetWebglTextureAtlases: vi.fn<() => void>(() => {
        throw new Error('pane disposed')
      }),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(broken)
    registeredManagers.push(broken)
    const healthy = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(healthy)
    registeredManagers.push(healthy)

    expect(() => resetAndRefreshAllTerminalWebglAtlases()).not.toThrow()

    expect(broken.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(broken.refreshAllPanes).not.toHaveBeenCalled()
    expect(healthy.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(healthy.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('fits and refreshes every registered manager', () => {
    const first = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      fitAllPanes: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>()
    }
    const second = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      fitAllPanes: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(first)
    registeredManagers.push(first)
    registerLivePaneManager(second)
    registeredManagers.push(second)

    refitAndRefreshAllTerminalPanes()

    expect(first.fitAllPanes).toHaveBeenCalledTimes(1)
    expect(first.refreshAllPanes).toHaveBeenCalledTimes(1)
    expect(second.fitAllPanes).toHaveBeenCalledTimes(1)
    expect(second.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('continues refitting later managers when one manager throws', () => {
    const broken = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      fitAllPanes: vi.fn<() => void>(() => {
        throw new Error('pane disposed')
      }),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(broken)
    registeredManagers.push(broken)
    const healthy = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      fitAllPanes: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(healthy)
    registeredManagers.push(healthy)

    expect(() => refitAndRefreshAllTerminalPanes()).not.toThrow()

    expect(broken.fitAllPanes).toHaveBeenCalledTimes(1)
    expect(broken.refreshAllPanes).not.toHaveBeenCalled()
    expect(healthy.fitAllPanes).toHaveBeenCalledTimes(1)
    expect(healthy.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('keeps pane keys stable when an earlier manager unregisters', () => {
    const first = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [{ id: 1, terminal: {} }]
    }
    const second = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [{ id: 1, terminal: {} }]
    }
    registerLivePaneManager(first)
    registeredManagers.push(first)
    registerLivePaneManager(second)
    registeredManagers.push(second)
    const before: string[] = []
    forEachLivePaneForDesyncSentinel((paneKey) => before.push(paneKey))

    unregisterLivePaneManager(first)
    const after: string[] = []
    forEachLivePaneForDesyncSentinel((paneKey) => after.push(paneKey))

    expect(before).toHaveLength(2)
    expect(after).toEqual([before[1]])
  })

  // Why: this is the number crash reports could never recover from breadcrumb
  // multiplicity, since every manager's first pane is id 1.
  it('counts panes across managers and drops them on unregister', () => {
    const twoPanes = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [
        { id: 1, terminal: {} },
        { id: 2, terminal: {} }
      ]
    }
    const onePane = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [{ id: 1, terminal: {} }]
    }
    registerLivePaneManager(twoPanes)
    registeredManagers.push(twoPanes)
    registerLivePaneManager(onePane)
    registeredManagers.push(onePane)

    expect(getLivePaneCensus()).toEqual({ managers: 2, panes: 3 })

    unregisterLivePaneManager(twoPanes)
    expect(getLivePaneCensus()).toEqual({ managers: 1, panes: 1 })
  })

  it('prefers the allocation-free pane count when a manager exposes one', () => {
    const counted = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPaneCount: () => 4,
      getPanes: vi.fn(() => [{ id: 1, terminal: {} }])
    }
    registerLivePaneManager(counted)
    registeredManagers.push(counted)

    expect(getLivePaneCensus()).toEqual({ managers: 1, panes: 4 })
    expect(counted.getPanes).not.toHaveBeenCalled()
  })

  it('counts surviving managers when one throws mid-teardown', () => {
    const broken = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => {
        throw new Error('disposed')
      }
    }
    const healthy = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [{ id: 1, terminal: {} }]
    }
    registerLivePaneManager(broken)
    registeredManagers.push(broken)
    registerLivePaneManager(healthy)
    registeredManagers.push(healthy)

    expect(getLivePaneCensus()).toEqual({ managers: 2, panes: 1 })
  })
})

describe('live terminal buffer census', () => {
  const registeredManagers: { resetWebglTextureAtlases(): void }[] = []

  function registerPanes(...panes: { id: number; terminal: unknown }[]): void {
    const manager = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => panes
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
  }

  function terminal(cols: number, lines: number, altScreen = false): unknown {
    return {
      cols,
      buffer: {
        normal: { length: lines },
        active: { type: altScreen ? 'alternate' : 'normal' }
      }
    }
  }

  afterEach(() => {
    for (const manager of registeredManagers.splice(0)) {
      unregisterLivePaneManager(manager)
    }
  })

  it('separates retained scrollback size from the live terminal count', () => {
    // Why: `terminalElements` says 2 either way; only lines/cells tell an idle
    // pair apart from a pair sitting at the 50k-row scrollback preset.
    registerPanes(
      { id: 1, terminal: terminal(120, 24) },
      { id: 2, terminal: terminal(120, 50_000) }
    )

    expect(getLiveTerminalBufferCensus()).toEqual({
      panes: 2,
      lines: 50_024,
      cells: 6_002_880,
      altScreenPanes: 0,
      droppedPanes: 0
    })
  })

  // Why: `buffer.active` is the alternate buffer while vim/less/an agent TUI is up,
  // and that buffer is viewport-sized — measured on @xterm/headless at 24 rows while
  // `normal` still held 5001. Reading `active` reports a pane retaining 50k lines as
  // retaining a screenful, which clears terminals of a leak they are causing.
  it('counts scrollback held behind an alt-screen app, not its viewport', () => {
    registerPanes(
      { id: 1, terminal: terminal(120, 50_000, true) },
      { id: 2, terminal: terminal(120, 24) }
    )

    expect(getLiveTerminalBufferCensus()).toEqual({
      panes: 2,
      lines: 50_024,
      cells: 6_002_880,
      altScreenPanes: 1,
      droppedPanes: 0
    })
  })

  it('reports into the renderer memory profile', () => {
    registerPanes({ id: 1, terminal: terminal(80, 5_000, true) })

    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'liveTerminalBuffers.panes': 1,
      'liveTerminalBuffers.lines': 5_000,
      'liveTerminalBuffers.cells': 400_000,
      'liveTerminalBuffers.altScreenPanes': 1,
      'liveTerminalBuffers.droppedPanes': 0
    })
  })

  // Why this counter exists: without it a census that threw on every pane reports
  // `panes: 0`, which reads as "no terminals were live" — the opposite conclusion.
  it('says how many panes it failed to read when a whole manager throws', () => {
    const broken = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPaneCount: () => 7,
      getPaneBufferCensus: (): never => {
        throw new Error('manager tearing down')
      }
    }
    registerLivePaneManager(broken)
    registeredManagers.push(broken)
    registerPanes({ id: 1, terminal: terminal(80, 10) })

    expect(getLiveTerminalBufferCensus()).toEqual({
      panes: 1,
      lines: 10,
      cells: 800,
      altScreenPanes: 0,
      droppedPanes: 7
    })
  })

  it('still reports at least one dropped pane when the count is unreadable too', () => {
    const broken = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPaneCount: (): never => {
        throw new Error('gone')
      },
      getPaneBufferCensus: (): never => {
        throw new Error('gone')
      }
    }
    registerLivePaneManager(broken)
    registeredManagers.push(broken)

    expect(getLiveTerminalBufferCensus().droppedPanes).toBe(1)
  })

  it('keeps counting siblings when a terminal throws on buffer access', () => {
    registerPanes(
      {
        id: 1,
        terminal: {
          get buffer(): never {
            throw new Error('torn down')
          }
        }
      },
      { id: 2, terminal: terminal(100, 10) }
    )

    expect(getLiveTerminalBufferCensus()).toEqual({
      panes: 1,
      lines: 10,
      cells: 1_000,
      altScreenPanes: 0,
      droppedPanes: 1
    })
  })

  it('prefers a manager census over materializing public pane views', () => {
    const counted = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPaneBufferCensus: () => ({
        panes: 2,
        lines: 30,
        cells: 3_000,
        altScreenPanes: 1,
        droppedPanes: 0
      }),
      getPanes: vi.fn(() => [{ id: 1, terminal: terminal(80, 10) }])
    }
    registerLivePaneManager(counted)
    registeredManagers.push(counted)

    expect(getLiveTerminalBufferCensus()).toEqual({
      panes: 2,
      lines: 30,
      cells: 3_000,
      altScreenPanes: 1,
      droppedPanes: 0
    })
    expect(counted.getPanes).not.toHaveBeenCalled()
  })

  it('tolerates a terminal with no buffer rather than emitting NaN', () => {
    registerPanes({ id: 1, terminal: {} })

    expect(getLiveTerminalBufferCensus()).toEqual({
      panes: 1,
      lines: 0,
      cells: 0,
      altScreenPanes: 0,
      droppedPanes: 0
    })
  })

  // Why the prototype and not a constructed manager: PaneManager needs a mounted DOM
  // root, and the only thing unpinned is that its census reads the live pane map
  // instead of some other source. A manager that returns zeros here is otherwise green.
  it('sums the real manager pane map, not a stale or empty source', () => {
    const panes = new Map<number, { terminal: unknown }>([
      [1, { terminal: terminal(80, 10) }],
      [2, { terminal: terminal(100, 20, true) }]
    ])

    const census = PaneManager.prototype.getPaneBufferCensus.call({
      panes
    } as unknown as PaneManager)

    expect(census).toEqual({
      panes: 2,
      lines: 30,
      cells: 2_800,
      altScreenPanes: 1,
      droppedPanes: 0
    })
  })
})
