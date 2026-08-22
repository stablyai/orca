import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installApi } from './web-preload-api-test-harness'

describe('web terminal window preload parity', () => {
  beforeEach(() => vi.resetModules())

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('keeps the four-method shape without native side effects', async () => {
    const { api } = await installApi()
    const callback = vi.fn()

    await expect(api.terminalWindow.detach({} as never)).resolves.toEqual({
      ok: false,
      error: 'terminal_window_transfer_unavailable'
    })
    expect(api.terminalWindow.ack({} as never)).toBeUndefined()
    const unsubscribe = api.terminalWindow.onCommand(callback)
    expect(unsubscribe()).toBeUndefined()
    expect(callback).not.toHaveBeenCalled()
    await expect(api.terminalWindow.getContext()).resolves.toEqual({
      windowId: 0,
      role: 'control',
      transitionFenced: false
    })
  })
})
