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

  it('returns null when a remount replaces an in-flight serializer', async () => {
    const { registerPtySerializer } = await import('./pty-buffer-serializer')
    let resolveOld: ((value: { data: string; cols: number; rows: number }) => void) | undefined
    const oldResult = new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
      resolveOld = resolve
    })
    registerPtySerializer('pty-1', () => oldResult)
    const serializeRequestHandler = vi.mocked(window.api.pty.onSerializeBufferRequest).mock
      .calls[0]?.[0]

    serializeRequestHandler?.({ requestId: 'request-1', ptyId: 'pty-1' })
    registerPtySerializer('pty-1', () => ({ data: 'live', cols: 80, rows: 24 }))
    resolveOld?.({ data: 'fossil', cols: 80, rows: 24 })
    await Promise.resolve()
    await Promise.resolve()

    expect(window.api.pty.sendSerializedBuffer).toHaveBeenCalledWith('request-1', null)
  })
})
