import { EventEmitter } from 'node:events'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { readRequestBody } from './agent-hook-listener'

type FakeIncomingMessage = EventEmitter & {
  headers: IncomingHttpHeaders
  destroy: ReturnType<typeof vi.fn>
}

function createReadableRequest(): FakeIncomingMessage {
  const request = new EventEmitter() as FakeIncomingMessage
  request.headers = { 'content-type': 'application/json' }
  request.destroy = vi.fn(() => request.emit('close'))
  return request
}

describe('agent hook request body retention', () => {
  it('accepts adversarial one-byte events without per-event retained buffers', async () => {
    const request = createReadableRequest()
    const reading = readRequestBody(request as unknown as IncomingMessage)
    const value = 'x'.repeat(100_000)
    const body = Buffer.from(JSON.stringify({ value }))

    for (let index = 0; index < body.length; index += 1) {
      request.emit('data', body.subarray(index, index + 1))
    }
    request.emit('end')

    await expect(reading).resolves.toEqual({ value })
  })
})
