import { expect, it } from 'vitest'
import { heldWorkerDeliveryText } from './agent-session-held-delivery'

it('directs another sender to its coordinator when no coordinator name is available', () => {
  const result = heldWorkerDeliveryText(
    {
      delivered: false,
      state: 'held',
      reason: { kind: 'worker_failed', failure: 'network' },
      failureId: 'observed-failure',
      target: { sessionId: 'worker', dispatchId: 'dispatch' },
      waiting: 1
    },
    { worker: 'Build worker', owner: 'the owner', provider: 'Codex', canResume: false }
  )
  expect(result.hint).toBe('Ask its coordinator to resume it.')
  expect(result.message).toBe(
    "Held, not delivered: Build worker stopped after a network error. Delivers when it's resumed. Don't resend."
  )
})
