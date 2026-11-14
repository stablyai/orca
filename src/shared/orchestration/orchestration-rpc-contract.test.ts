import { describe, expect, it } from 'vitest'
import { isOrchestrationMutation } from './orchestration-rpc-contract'

describe('orchestration RPC contract', () => {
  it.each([
    ['orchestration.dispatch', {}],

    ['orchestration.check', {}],
    ['orchestration.check', { wait: true }],
    ['orchestration.check', { unread: true }],
    ['orchestration.check', { peek: true, ack: 'delivery_1' }]
  ])('classifies %s as a mutation', (method, params) => {
    expect(isOrchestrationMutation(method, params)).toBe(true)
  })

  it.each([
    ['orchestration.dispatch', { dryRun: true }],
    ['orchestration.check', { peek: true }],
    ['orchestration.check', { all: true }],
    ['orchestration.check', { unread: false }]
  ])('classifies %s as read-only', (method, params) => {
    expect(isOrchestrationMutation(method, params)).toBe(false)
  })
})
