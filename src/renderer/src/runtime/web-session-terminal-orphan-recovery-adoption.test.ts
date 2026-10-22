import { describe, expect, it } from 'vitest'
import { isStableAdoptionFailure } from './web-session-terminal-orphan-recovery-adoption'

function failure(code: string, message = 'refused'): unknown {
  return { id: 'adopt', ok: false, error: { code, message } }
}

// Pins which adoption failures stop retrying (round-2 S5), so a dropped code is deliberate.
describe('isStableAdoptionFailure', () => {
  it.each(['method_not_found', 'capability_unsupported', 'invalid_runtime_response'])(
    'treats %s as stable',
    (code) => {
      expect(isStableAdoptionFailure(failure(code))).toBe(true)
    }
  )

  it.each([
    'remote_runtime_unavailable',
    'remote_runtime_busy',
    'runtime_rpc_queue_overloaded',
    'runtime_timeout',
    'runtime_unavailable',
    'reconnecting',
    'timeout',
    'runtime_manually_disconnected',
    'terminal_not_found'
  ])('keeps retrying after %s', (code) => {
    expect(isStableAdoptionFailure(failure(code))).toBe(false)
  })

  it('keeps retrying a code-stripped connection failure even if it names a stable code', () => {
    expect(
      isStableAdoptionFailure(
        new Error('Could not connect to the remote Orca runtime: method_not_found')
      )
    ).toBe(false)
  })

  it('reads a stable code from a thrown error message token', () => {
    expect(isStableAdoptionFailure(new Error('Adoption failed: capability_unsupported'))).toBe(true)
  })
})
