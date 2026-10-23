import { describe, expect, it } from 'vitest'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime-client-error'
import { classifyAutomationHostQueryError } from './automation-host-cache-error'

function classify(error: unknown): { code: string; retryable: boolean } {
  const { code, retryable } = classifyAutomationHostQueryError(error, { attempt: 1, now: 0 })
  return { code, retryable }
}

// Pins the RPC-code mapping of host query failures (round-2 S5), so a dropped code is deliberate.
describe('classifyAutomationHostQueryError code mapping', () => {
  it.each([
    ['runtime_unavailable', 'authority_unavailable', true],
    ['remote_runtime_unavailable', 'authority_unavailable', true],
    ['relay_quota_exceeded', 'authority_unavailable', true],
    ['timeout', 'timeout', true],
    ['runtime_timeout', 'timeout', true],
    ['permission_denied', 'permission_denied', false],
    ['unauthorized', 'permission_denied', false],
    ['forbidden', 'permission_denied', false],
    ['capability_unsupported', 'incompatible', false],
    ['legacy_read_only', 'incompatible', false],
    ['invalid_runtime_response', 'invalid_response', false],
    ['invalid_argument', 'invalid_response', false],
    ['runtime_manually_disconnected', 'unknown', true],
    ['runtime_rpc_queue_overloaded', 'unknown', true],
    ['remote_runtime_busy', 'unknown', true]
  ])('maps %s to %s (retryable: %s)', (rpcCode, code, retryable) => {
    expect(classify(new RemoteRuntimeClientError(rpcCode, 'failed'))).toEqual({ code, retryable })
  })

  it('reads a code-stripped message token', () => {
    expect(
      classify(new Error("Error invoking remote method 'x': Error: failed: runtime_timeout"))
    ).toEqual({ code: 'timeout', retryable: true })
  })
})
