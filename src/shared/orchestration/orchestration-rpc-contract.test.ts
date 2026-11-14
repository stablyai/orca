import { describe, expect, it } from 'vitest'
import { isOrchestrationMutation } from './orchestration-rpc-contract'

describe('orchestration RPC contract', () => {
  it('treats a peek with acknowledgement as a mutation', () => {
    expect(isOrchestrationMutation('orchestration.check', { peek: true, ack: 'delivery_1' })).toBe(
      true
    )
  })

  it('keeps a peek without acknowledgement read-only', () => {
    expect(isOrchestrationMutation('orchestration.check', { peek: true })).toBe(false)
  })
})
