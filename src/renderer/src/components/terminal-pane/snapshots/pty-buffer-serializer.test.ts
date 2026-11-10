import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('pty buffer serializer registry', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    vi.resetModules()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry reads only these pty members.
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          onClearBufferRequest: vi.fn(() => () => {}),
          onResetInputModesRequest: vi.fn(() => () => {}),
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
