import { describe, expect, it } from 'vitest'
import {
  RECOVERABLE_CODES,
  RECOVERABLE_MESSAGE_FRAGMENTS,
  isRecoverableRemoteRuntimeConnectionError,
  isRuntimeRpcQueueOverloadError,
  toRemoteRuntimeClientErrorLike
} from './remote-runtime-client-error-classification'

describe('remote runtime client error classification', () => {
  it.each([
    'remote_runtime_unavailable',
    'remote_runtime_busy',
    'runtime_rpc_queue_overloaded',
    'runtime_timeout',
    'runtime_unavailable',
    'reconnecting'
  ])('treats %s as recoverable', (code) => {
    expect(isRecoverableRemoteRuntimeConnectionError({ code, message: 'transport failed' })).toBe(
      true
    )
  })

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

  it('trusts a structured recovery code before legacy message fragments', () => {
    expect(
      isRecoverableRemoteRuntimeConnectionError({
        code: 'unauthorized',
        message: 'Remote Orca runtime closed the connection.'
      })
    ).toBe(false)
  })

  it('trusts a structured queue code before legacy message fragments', () => {
    expect(
      isRuntimeRpcQueueOverloadError({
        code: 'remote_runtime_unavailable',
        message: 'Remote runtime call queue is full; retry after current calls finish.'
      })
    ).toBe(false)
  })

  it.each([
    'Could not connect to the remote Orca runtime.',
    'Remote Orca runtime closed the connection.',
    'Remote Orca runtime connection closed.',
    'Remote Orca runtime is not connected.',
    "Error invoking remote method 'runtimeEnvironments:call': RuntimeRpcCallQueueOverloadError: Remote runtime call queue is full; retry after current calls finish.",
    'Remote runtime subscription closed before it started.',
    "Error invoking remote method 'runtimeEnvironments:call': Error: Remote runtime request limit reached; retry after pending requests finish."
  ])('normalizes unstructured connection failure: %s', (message) => {
    const error = toRemoteRuntimeClientErrorLike(new Error(message))
    expect(isRecoverableRemoteRuntimeConnectionError(error)).toBe(true)
  })

  // Pins the list so a dropped or added code is a deliberate, reviewed change (round-2 S5).
  it('pins the recoverable codes and message fragments', () => {
    expect([...RECOVERABLE_CODES].toSorted()).toEqual([
      'reconnecting',
      'remote_runtime_busy',
      'remote_runtime_unavailable',
      'runtime_rpc_queue_overloaded',
      'runtime_timeout',
      'runtime_unavailable',
      'timeout'
    ])
    expect(RECOVERABLE_MESSAGE_FRAGMENTS).toEqual([
      'could not connect to the remote orca runtime',
      'remote orca runtime closed the connection',
      'remote orca runtime connection closed',
      'remote orca runtime is not connected',
      'remote runtime call queue is full',
      'remote runtime connection closed',
      'remote runtime connection wait limit reached',
      'remote runtime request limit reached',
      'remote runtime subscription limit reached',
      'remote runtime subscription memory limit reached',
      'remote runtime subscription closed before it started',
      'remote terminal stream is not connected',
      'timed out waiting for the remote orca runtime'
    ])
  })

  it.each([
    'runtime_manually_disconnected',
    'ssh_user_disconnected',
    'remote_runtime_timeout',
    'runtime_busy'
  ])('does not treat client code %s as recoverable', (code) => {
    expect(isRecoverableRemoteRuntimeConnectionError({ code, message: 'refused' })).toBe(false)
  })

  it.each(RECOVERABLE_MESSAGE_FRAGMENTS)(
    'recovers a code-stripped message containing %s',
    (fragment) => {
      expect(
        isRecoverableRemoteRuntimeConnectionError(
          toRemoteRuntimeClientErrorLike(
            new Error(`Error invoking remote method 'x': Error: ${fragment}.`)
          )
        )
      ).toBe(true)
    }
  )
})
