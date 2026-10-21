import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_CONNECTION_CHANGED_MESSAGE,
  WebRuntimeRequestRegistry
} from './web-runtime-request-registry'

describe('web runtime request connection pin', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not send a pinned request after the same client silently reconnected', async () => {
    let reconnect: () => void = () => undefined
    const sendEncrypted = vi.fn(() => true)
    const registry: WebRuntimeRequestRegistry = new WebRuntimeRequestRegistry({
      deviceToken: 'token',
      nextId: () => 'req-1',
      // The socket drops after the probe; the call waits and resumes on the new connection.
      waitForConnected: () =>
        new Promise<void>((resolve) => {
          reconnect = () => {
            registry.connectionOpened()
            resolve()
          }
        }),
      sendEncrypted
    })
    registry.connectionOpened()
    const probedEpoch = registry.connectionEpoch

    const write = registry.call('files.write', {}, { expectedConnectionEpoch: probedEpoch })
    reconnect()

    await expect(write).rejects.toThrow(RUNTIME_CONNECTION_CHANGED_MESSAGE)
    expect(sendEncrypted).not.toHaveBeenCalled()
  })
})
