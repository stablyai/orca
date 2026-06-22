import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import {
  maybeScheduleWebglAtlasRecoveryForPaste,
  schedulePasteWebglAtlasRecovery
} from './terminal-webgl-paste-recovery'

describe('terminal paste WebGL recovery', () => {
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

    schedulePasteWebglAtlasRecovery()

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

    schedulePasteWebglAtlasRecovery()

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

    expect(() => schedulePasteWebglAtlasRecovery()).not.toThrow()
    expect(() => vi.runAllTimers()).not.toThrow()
  })

  describe('maybeScheduleWebglAtlasRecoveryForPaste', () => {
    it('recovers the atlas after a bracketed paste (image or corrupting text)', () => {
      vi.useFakeTimers()
      vi.stubGlobal('requestAnimationFrame', undefined)
      const manager = registerManager()

      maybeScheduleWebglAtlasRecoveryForPaste({ bracketed: true })

      vi.advanceTimersByTime(500)
      expect(manager.resetWebglTextureAtlases).toHaveBeenCalled()
    })

    it('skips recovery for a direct (non-bracketed) paste', () => {
      vi.useFakeTimers()
      vi.stubGlobal('requestAnimationFrame', undefined)
      const manager = registerManager()

      maybeScheduleWebglAtlasRecoveryForPaste({ bracketed: false })

      vi.advanceTimersByTime(500)
      expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    })
  })
})
