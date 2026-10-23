import { describe, expect, it } from 'vitest'
import { isTerminalCreatedHere } from './runtime-terminal-contracts'

describe('isTerminalCreatedHere', () => {
  it.each([
    ['no disposition', {}],
    ['an explicit created disposition', { agentSessionDisposition: 'created' }]
  ])('is true for %s', (_label, reply) => {
    expect(isTerminalCreatedHere(reply)).toBe(true)
  })

  it.each([
    ['a reattach', { isReattach: true }],
    ['an adopted session', { agentSessionDisposition: 'adopted' }],
    ['an adopted reattach', { isReattach: true, agentSessionDisposition: 'adopted' }],
    // Off-contract values never authorize a close.
    ['a false reattach flag', { isReattach: false }],
    ['a null reattach flag', { isReattach: null }],
    ['a string reattach flag', { isReattach: 'yes' }],
    ['a null disposition', { agentSessionDisposition: null }],
    ['an empty disposition', { agentSessionDisposition: '' }],
    ['an unknown disposition', { agentSessionDisposition: 'other' }],
    ['a numeric disposition', { agentSessionDisposition: 1 }],
    [
      'a created disposition on a reattach',
      { isReattach: true, agentSessionDisposition: 'created' }
    ]
  ])('is false for %s', (_label, reply) => {
    expect(isTerminalCreatedHere(reply)).toBe(false)
  })
})
