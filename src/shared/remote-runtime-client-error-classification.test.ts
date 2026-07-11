import { describe, expect, it } from 'vitest'
import { isRecoverableRemoteRuntimeConnectionError } from './remote-runtime-client-error-classification'

describe('isRecoverableRemoteRuntimeConnectionError', () => {
  it('classifies only connection availability and timeout errors as recoverable', () => {
    expect(
      isRecoverableRemoteRuntimeConnectionError({
        code: 'remote_runtime_unavailable',
        message: 'offline'
      })
    ).toBe(true)
    expect(
      isRecoverableRemoteRuntimeConnectionError({
        code: 'runtime_timeout',
        message: 'timeout'
      })
    ).toBe(true)

    for (const code of [
      'unauthorized',
      'invalid_argument',
      'invalid_runtime_response',
      'runtime_error'
    ]) {
      expect(isRecoverableRemoteRuntimeConnectionError({ code, message: code })).toBe(false)
    }
  })
})
