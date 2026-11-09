// Route restore markers out of band; empty data chunks also result from fully stripped OSC 9999 and cannot prove a gap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('pty model-restore channel routing', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onModelRestoreNeeded: ReturnType<typeof vi.fn>
  let channelCallback: ((event: { id: string; reason: string; markerSeq?: number }) => void) | null

  beforeEach(() => {
    vi.resetModules()
    channelCallback = null
    onModelRestoreNeeded = vi.fn(
      (callback: (event: { id: string; reason: string; markerSeq?: number }) => void) => {
        channelCallback ??= callback
        return () => {}
      }
    )
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          onModelRestoreNeeded
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('lets a new registration replace a stale one without the stale unregister clobbering it', async () => {
    const { registerPtyModelRestoreNeededHandler } = await import('./pty-model-restore-channel')
    const staleHandler = vi.fn()
    const liveHandler = vi.fn()

    const unregisterStale = registerPtyModelRestoreNeededHandler('pty-a', staleHandler)
    registerPtyModelRestoreNeededHandler('pty-a', liveHandler)
    // Late unregister cannot remove a replacement handler registered during reattach.
    unregisterStale()

    channelCallback?.({ id: 'pty-a', reason: 'unhide' })
    expect(staleHandler).not.toHaveBeenCalled()
    expect(liveHandler).toHaveBeenCalledTimes(1)
  })
})
