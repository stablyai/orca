import { expect, it } from 'vitest'
import {
  structuredAgentSessionNewSendsQueue,
  structuredAgentSessionQueueRequest
} from './structured-agent-session-queue-request'

it('asks the host to queue only a host that queues, with queueing on', () => {
  expect(structuredAgentSessionQueueRequest({ capability: 'supported', enabled: true })).toBe(
    'queue-if-active'
  )
  for (const queue of [
    { capability: 'supported' as const, enabled: false },
    { capability: 'unsupported' as const, enabled: true },
    { capability: 'unknown' as const, enabled: true }
  ]) {
    expect(structuredAgentSessionQueueRequest(queue)).toBeUndefined()
    expect(structuredAgentSessionNewSendsQueue(queue)).toBe(false)
  }
  expect(structuredAgentSessionNewSendsQueue({ capability: 'supported', enabled: true })).toBe(true)
})
