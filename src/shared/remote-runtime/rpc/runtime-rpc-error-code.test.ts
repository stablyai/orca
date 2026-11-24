import { describe, expect, it } from 'vitest'
import { readRuntimeRpcErrorCode } from './runtime-rpc-error-code'

const KNOWN = ['invalid_argument', 'selector_not_found', 'runtime_error']

describe('readRuntimeRpcErrorCode', () => {
  it('finds a known host error code wrapped in causes', () => {
    const rpcError = Object.assign(new Error('Browser profile work was not found'), {
      code: 'invalid_argument'
    })
    expect(readRuntimeRpcErrorCode(new Error('wrapped', { cause: rpcError }), KNOWN)).toBe(
      'invalid_argument'
    )
  })

  it("names an older host's specific refusal, not the runtime_error it was flattened into", () => {
    const flattened = {
      response: { error: { code: 'runtime_error', message: 'selector_not_found' } }
    }
    expect(readRuntimeRpcErrorCode(flattened, KNOWN)).toBe('selector_not_found')
  })

  it('never returns a code outside the known list, which a host could fill with any text', () => {
    expect(readRuntimeRpcErrorCode({ code: 'session_token_abc123' }, KNOWN)).toBe('other_code')
    expect(readRuntimeRpcErrorCode(new Error('plain failure'), KNOWN)).toBeNull()
  })
})
