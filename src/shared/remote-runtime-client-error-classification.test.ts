import { describe, expect, it } from 'vitest'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from './remote-runtime-client-error-classification'

describe('remote runtime client error classification', () => {
  it.each(['remote_runtime_unavailable', 'runtime_timeout', 'runtime_unavailable', 'reconnecting'])(
    'treats %s as recoverable',
    (code) => {
      expect(isRecoverableRemoteRuntimeConnectionError({ code, message: 'transport failed' })).toBe(
        true
      )
    }
  )

  it('does not retry authentication or protocol failures', () => {
    expect(
      isRecoverableRemoteRuntimeConnectionError({ code: 'unauthorized', message: 'bad token' })
    ).toBe(false)
    expect(
      isRecoverableRemoteRuntimeConnectionError({
        code: 'invalid_runtime_response',
        message: 'bad frame'
      })
    ).toBe(false)
  })

  it('normalizes unstructured connection failures from older clients', () => {
    const error = toRemoteRuntimeClientErrorLike(
      new Error('Could not connect to the remote Orca runtime.')
    )
    expect(isRecoverableRemoteRuntimeConnectionError(error)).toBe(true)
  })
})
