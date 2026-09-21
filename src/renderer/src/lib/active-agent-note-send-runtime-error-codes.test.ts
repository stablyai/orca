import { describe, expect, it } from 'vitest'
import { hasRuntimeRpcErrorCode, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import {
  isRuntimeTerminalNotWritable,
  isRuntimeTerminalUnavailable,
  isRuntimeTimeout
} from './active-agent-terminal-send-readiness'
import {
  runtimeFailureCode,
  runtimeFailureFallbackCode
} from './active-agent-note-send-diagnostics'

function runtimeError(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'test-runtime-error',
    ok: false,
    error: { code, message: 'The terminal is no longer available' }
  })
}

describe('active agent note runtime error codes', () => {
  it.each(['terminal_handle_stale', 'terminal_exited', 'terminal_gone', 'no_active_terminal'])(
    'uses structured %s codes even with human-readable messages',
    (code) => {
      const error = runtimeError(code)

      expect(isRuntimeTerminalUnavailable(error)).toBe(true)
      expect(runtimeFailureCode(error)).toBe(code)
    }
  )

  it('uses structured terminal_not_writable with a human-readable message', () => {
    const error = runtimeError('terminal_not_writable')

    expect(isRuntimeTerminalNotWritable(error)).toBe(true)
    expect(hasRuntimeRpcErrorCode(error, 'terminal_not_writable')).toBe(true)
  })

  it('uses structured runtime_timeout with a human-readable message', () => {
    const error = new RuntimeRpcCallError({
      id: 'test-runtime-timeout',
      ok: false,
      error: { code: 'runtime_timeout', message: 'Timed out waiting for the remote runtime.' }
    })

    expect(isRuntimeTimeout(error)).toBe(true)
    expect(runtimeFailureFallbackCode(error)).toBe('runtime-timeout')
  })

  it('retains support for transport-rewrapped error tokens', () => {
    const error = new Error("Error invoking remote method 'terminal.send': terminal_gone")

    expect(isRuntimeTerminalUnavailable(error)).toBe(true)
    expect(runtimeFailureCode(error)).toBe('terminal_gone')
  })
})
