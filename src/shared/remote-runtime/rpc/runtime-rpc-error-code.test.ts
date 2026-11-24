import { describe, expect, it } from 'vitest'
import { readRuntimeRpcErrorCode } from './runtime-rpc-error-code'

describe('readRuntimeRpcErrorCode', () => {
  it('finds a host error code wrapped in causes', () => {
    const rpcError = Object.assign(new Error('Browser profile work was not found'), {
      code: 'invalid_argument'
    })
    expect(readRuntimeRpcErrorCode(new Error('wrapped', { cause: rpcError }))).toBe(
      'invalid_argument'
    )
    expect(readRuntimeRpcErrorCode({ response: { error: { code: 'selector_not_found' } } })).toBe(
      'selector_not_found'
    )
  })

  it('never returns free text, which can carry a URL', () => {
    expect(readRuntimeRpcErrorCode({ code: 'https://github.com/org/repo/pull/1' })).toBeNull()
    expect(readRuntimeRpcErrorCode(new Error('invalid_argument'))).toBeNull()
  })
})
