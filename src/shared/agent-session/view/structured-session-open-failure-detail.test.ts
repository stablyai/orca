import { describe, expect, it } from 'vitest'
import { structuredSessionOpenFailure } from './open-structured-agent-session'
import { unreachableOpenFailure } from './structured-session-open-failure-detail'

describe('unreachableOpenFailure', () => {
  it('keeps the raw code and message for Show details', () => {
    expect(unreachableOpenFailure({ code: 'timeout', message: 'Host did not answer.' })).toEqual({
      reason: 'unreachable',
      beforeEffects: false,
      detail: 'timeout: Host did not answer.'
    })
  })

  it('reads Error and string causes', () => {
    expect(unreachableOpenFailure(new Error('socket closed')).detail).toBe('socket closed')
    expect(unreachableOpenFailure('disconnected').detail).toBe('disconnected')
  })

  it('omits detail when the cause says nothing', () => {
    expect(unreachableOpenFailure(undefined)).toEqual({
      reason: 'unreachable',
      beforeEffects: false
    })
  })

  it('backs the catch-all of structuredSessionOpenFailure', () => {
    expect(structuredSessionOpenFailure(new Error('host crashed'))).toEqual({
      reason: 'unreachable',
      beforeEffects: false,
      detail: 'host crashed'
    })
  })
})
