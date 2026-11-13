import { describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from '../publication/dispatcher'
import type { RelayClient } from './dispatcher-contract'
import type { JsonRpcNotification } from '../wire/protocol'

type DispatcherInternals = {
  primaryClient: RelayClient
  estimateFrameBytes: (msg: JsonRpcNotification) => number
  enqueueFrame: (client: RelayClient, msg: JsonRpcNotification, lane: string) => boolean
}

describe('RelayDispatcher frame guards', () => {
  it('returns zero for invalid active-client limits without encoding', () => {
    const dispatcher = new RelayDispatcher(() => true, {
      writableHighWaterMark: () => 1024 * 1024,
      writableLength: () => 0
    })
    try {
      const spy = vi.spyOn(dispatcher as unknown as DispatcherInternals, 'estimateFrameBytes')
      for (const limit of [0, -1, Number.NaN]) {
        expect(dispatcher.maxLegacyPtyDataChars({ id: 'pty-1' }, 'hello', limit)).toBe(0)
      }
      expect(spy).not.toHaveBeenCalled()
    } finally {
      dispatcher.dispose()
    }
  })
})
