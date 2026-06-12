import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import { scheduleImagePasteWebglAtlasRecovery } from './terminal-webgl-paste-recovery'

describe('terminal image paste WebGL recovery', () => {
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
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('clears atlases on the next frame and through the post-paste redraw window', () => {
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
    // sharing the glyph atlas rebuilds, not just the pasted-into pane.
    const manager = registerManager()
    const otherManager = registerManager()

    scheduleImagePasteWebglAtlasRecovery()

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    rafCallbacks[0]?.(0)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(otherManager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(120)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(380)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
  })

  it('falls back to a timeout when animation frames are unavailable', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', undefined)
    const manager = registerManager()

    scheduleImagePasteWebglAtlasRecovery()

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
  })

  it('ignores resets after the pane has unmounted', () => {
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
      })
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)

    expect(() => scheduleImagePasteWebglAtlasRecovery()).not.toThrow()
    expect(() => vi.runAllTimers()).not.toThrow()
  })
})
