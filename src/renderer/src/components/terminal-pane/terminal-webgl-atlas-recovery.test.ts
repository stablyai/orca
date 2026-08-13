import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import * as terminalWebglAtlasRecovery from './terminal-webgl-atlas-recovery'

const { scheduleImagePasteWebglAtlasRecovery, scheduleTabRevealWebglAtlasRecovery } =
  terminalWebglAtlasRecovery

describe('terminal WebGL atlas recovery', () => {
  const registeredManagers: { resetWebglTextureAtlases(): void }[] = []

  function registerManager(): {
    resetWebglTextureAtlases: Mock<() => void>
    refreshAllPanes: Mock<() => void>
    scheduleRevealPresent: Mock<() => void>
  } {
    const manager = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>(),
      scheduleRevealPresent: vi.fn<() => void>()
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    return manager
  }

  afterEach(() => {
    for (const manager of registeredManagers.splice(0)) {
      unregisterLivePaneManager(manager)
    }
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('limits atlas recovery to explicit renderer lifecycle events', () => {
    expect(terminalWebglAtlasRecovery).not.toHaveProperty('scheduleTerminalWebglAtlasRecovery')
  })

  it('clears atlases and refreshes panes through the post-paste redraw window', () => {
    vi.useFakeTimers()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      })
    )
    // Why: resets go through the live-manager registry so every terminal
    // sharing the glyph atlas rebuilds and repaints, not just the paste target.
    const manager = registerManager()
    const otherManager = registerManager()

    scheduleImagePasteWebglAtlasRecovery()

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    rafCallbacks[0]?.(0)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
    expect(otherManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(otherManager.refreshAllPanes).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(120)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(2)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(380)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(3)
    // Why paste keeps every wipe: an image chip can redraw after bracketed
    // paste parsing and corrupt the shared atlas with no context-loss event.
    // Only clearTextureAtlas repairs that — a plain present would recomposite
    // the same broken texture — and paste has no settled-reveal follow-up.
    expect(manager.scheduleRevealPresent).not.toHaveBeenCalled()
    expect(otherManager.scheduleRevealPresent).not.toHaveBeenCalled()
  })

  it('refreshes after each scheduled atlas reset', () => {
    vi.useFakeTimers()
    const order: string[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = {
      resetWebglTextureAtlases: vi.fn(() => order.push('first-reset')),
      refreshAllPanes: vi.fn(() => order.push('first-refresh')),
      scheduleRevealPresent: vi.fn(() => order.push('first-present'))
    }
    const otherManager = {
      resetWebglTextureAtlases: vi.fn(() => order.push('second-reset')),
      refreshAllPanes: vi.fn(() => order.push('second-refresh')),
      scheduleRevealPresent: vi.fn(() => order.push('second-present'))
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    registerLivePaneManager(otherManager)
    registeredManagers.push(otherManager)

    scheduleImagePasteWebglAtlasRecovery()
    vi.advanceTimersByTime(500)

    expect(order).toEqual([
      'first-reset',
      'second-reset',
      'first-refresh',
      'second-refresh',
      'first-reset',
      'second-reset',
      'first-refresh',
      'second-refresh',
      'first-reset',
      'second-reset',
      'first-refresh',
      'second-refresh'
    ])
  })

  it('presents instead of re-wiping through the tab-reveal coverage window', () => {
    vi.useFakeTimers()
    const order: string[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = {
      resetWebglTextureAtlases: vi.fn(() => order.push('first-reset')),
      refreshAllPanes: vi.fn(() => order.push('first-refresh')),
      scheduleRevealPresent: vi.fn(() => order.push('first-present'))
    }
    const otherManager = {
      resetWebglTextureAtlases: vi.fn(() => order.push('second-reset')),
      refreshAllPanes: vi.fn(() => order.push('second-refresh')),
      scheduleRevealPresent: vi.fn(() => order.push('second-present'))
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    registerLivePaneManager(otherManager)
    registeredManagers.push(otherManager)

    scheduleTabRevealWebglAtlasRecovery()
    vi.advanceTimersByTime(500)

    // The degraded coverage shots still fan out registry-wide, so a sibling
    // terminal sharing the atlas presents as often as the revealed tab.
    expect(order).toEqual([
      'first-reset',
      'second-reset',
      'first-refresh',
      'second-refresh',
      'first-present',
      'second-present',
      'first-present',
      'second-present'
    ])
  })

  it('falls back to a timeout when animation frames are unavailable', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', undefined)
    const manager = registerManager()

    scheduleImagePasteWebglAtlasRecovery()

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('continues recovery when a manager throws after scheduling', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = {
      resetWebglTextureAtlases: vi.fn(() => {
        throw new Error('pane disposed')
      }),
      refreshAllPanes: vi.fn(),
      scheduleRevealPresent: vi.fn(() => {
        throw new Error('pane disposed')
      })
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    const healthyManager = registerManager()

    expect(() => scheduleImagePasteWebglAtlasRecovery()).not.toThrow()
    expect(() => vi.runAllTimers()).not.toThrow()
    expect(healthyManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
    expect(healthyManager.refreshAllPanes).toHaveBeenCalledTimes(3)
    expect(manager.refreshAllPanes).not.toHaveBeenCalled()
  })

  it('keeps presenting siblings when a manager throws on a reveal coverage shot', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = {
      resetWebglTextureAtlases: vi.fn(() => {
        throw new Error('pane disposed')
      }),
      refreshAllPanes: vi.fn(),
      scheduleRevealPresent: vi.fn(() => {
        throw new Error('pane disposed')
      })
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    const healthyManager = registerManager()

    expect(() => scheduleTabRevealWebglAtlasRecovery()).not.toThrow()
    expect(() => vi.runAllTimers()).not.toThrow()
    expect(healthyManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(healthyManager.refreshAllPanes).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).not.toHaveBeenCalled()
    expect(healthyManager.scheduleRevealPresent).toHaveBeenCalledTimes(2)
  })

  it('recovers immediately on a tab reveal', () => {
    vi.useFakeTimers()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      })
    )
    const manager = registerManager()

    scheduleTabRevealWebglAtlasRecovery()
    rafCallbacks[0]?.(0)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
    expect(manager.scheduleRevealPresent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(120)
    vi.advanceTimersByTime(380)
    // Why: a reveal needs exactly one shared-atlas wipe. The first shot already
    // zeroed every render model, so the coverage shots repaint by presenting.
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
    expect(manager.scheduleRevealPresent).toHaveBeenCalledTimes(2)
  })
})
