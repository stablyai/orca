import { expect, it } from 'vitest'
import {
  structuredAgentSessionNewSendsQueue,
  structuredAgentSessionQueueRequest
} from './structured-agent-session-queue-request'

const image = [{ path: '/tmp/a.png', previewUri: '/tmp/a.png' }]

it('asks the host to queue only a text send, to a host that queues, with queueing on', () => {
  expect(structuredAgentSessionQueueRequest({ capability: 'supported', enabled: true }, [])).toBe(
    'queue-if-active'
  )
  // Its queue takes only text: an image goes out at once.
  expect(
    structuredAgentSessionQueueRequest({ capability: 'supported', enabled: true }, image)
  ).toBeUndefined()
  // Queueing off, or a host that does not queue or has not said yet: a plain send.
  for (const queue of [
    { capability: 'supported' as const, enabled: false },
    { capability: 'unsupported' as const, enabled: true },
    { capability: 'unknown' as const, enabled: true }
  ]) {
    expect(structuredAgentSessionQueueRequest(queue, [])).toBeUndefined()
    expect(structuredAgentSessionNewSendsQueue(queue)).toBe(false)
  }
  expect(structuredAgentSessionNewSendsQueue({ capability: 'supported', enabled: true })).toBe(true)
})
