import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IDisposable } from '@xterm/xterm'

describe('pty buffer serializer registry', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          onClearBufferRequest: vi.fn(() => () => {}),
          onSerializeBufferRequest: vi.fn(() => () => {}),
          sendSerializedBuffer: vi.fn()
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

  it('tracks a remounted quiet title source even when the stale owner unregisters later', async () => {
    const { registerPtySerializer, registerPtyTitleSource } =
      await import('./pty-buffer-serializer')
    const oldDispose = vi.fn()
    const newDispose = vi.fn()

    const unregisterOldSerializer = registerPtySerializer('pty-1', () => null)
    const unregisterOldTitle = registerPtyTitleSource(
      'pty-1',
      () => ({ dispose: oldDispose }) satisfies IDisposable
    )

    const unregisterNewSerializer = registerPtySerializer('pty-1', () => null)
    const unregisterNewTitle = registerPtyTitleSource(
      'pty-1',
      () => ({ dispose: newDispose }) satisfies IDisposable
    )

    expect(oldDispose).toHaveBeenCalledTimes(1)
    expect(newDispose).not.toHaveBeenCalled()

    unregisterOldTitle()
    unregisterOldSerializer()

    expect(newDispose).not.toHaveBeenCalled()

    unregisterNewTitle()
    unregisterNewSerializer()

    expect(newDispose).toHaveBeenCalledTimes(1)
  })
})
