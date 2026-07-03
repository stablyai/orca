import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import {
  scheduleImagePasteWebglAtlasRecovery,
  scheduleTerminalWebglAtlasRecovery
} from './terminal-webgl-atlas-recovery'

describe('terminal WebGL atlas recovery', () => {
  const registeredManagers: { resetWebglTextureAtlases(): void }[] = []

  function registerManager(): {
    resetWebglTextureAtlases: Mock<() => void>
    refreshAllPanes: Mock<() => void>
  } {
    const manager = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    return manager
  }

  afterEach(() => {
    for (const manager of registeredManagers.splice(0)) {
      unregisterLivePaneManager(manager)
    }
    vi.useRealTimers()
    vi.unstubAllGlobals()
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
      refreshAllPanes: vi.fn(() => order.push('first-refresh'))
    }
    const otherManager = {
      resetWebglTextureAtlases: vi.fn(() => order.push('second-reset')),
      refreshAllPanes: vi.fn(() => order.push('second-refresh'))
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
      refreshAllPanes: vi.fn()
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

  it('coalesces terminal-output atlas recovery across a redraw burst', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
    const manager = registerManager()

    scheduleTerminalWebglAtlasRecovery()
    scheduleTerminalWebglAtlasRecovery()
    scheduleTerminalWebglAtlasRecovery()

    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(120)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(2)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(2)
    scheduleTerminalWebglAtlasRecovery()
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(380)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(3)

    scheduleTerminalWebglAtlasRecovery()
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(4)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(500)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(6)
    expect(manager.refreshAllPanes).toHaveBeenCalledTimes(6)
  })
})
