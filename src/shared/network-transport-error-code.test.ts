import { describe, expect, it } from 'vitest'
import { networkTransportErrorCode } from './network-transport-error-code'

function fetchRejection(code: string): Error {
  // Shape of a real global fetch rejection: a bare message with the reason on the cause.
  return new TypeError('fetch failed', { cause: Object.assign(new Error('...'), { code }) })
}

describe('networkTransportErrorCode', () => {
  it('reads the reason a fetch rejection hides behind its cause', () => {
    expect(networkTransportErrorCode(fetchRejection('SELF_SIGNED_CERT_IN_CHAIN'))).toBe(
      'SELF_SIGNED_CERT_IN_CHAIN'
    )
    expect(networkTransportErrorCode(fetchRejection('ENOTFOUND'))).toBe('ENOTFOUND')
  })

  it('reads a code carried directly on the error', () => {
    expect(networkTransportErrorCode(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(
      'ETIMEDOUT'
    )
  })

  it('walks nested causes up to the bound', () => {
    const nested = new TypeError('fetch failed', {
      cause: new Error('socket', {
        cause: Object.assign(new Error('tls'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
      })
    })
    expect(networkTransportErrorCode(nested)).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  })

  it('returns null past the depth bound so a cause chain cannot loop', () => {
    const deep = { cause: { cause: { cause: { cause: { code: 'ETIMEDOUT' } } } } }
    expect(networkTransportErrorCode(deep)).toBeNull()
    const cyclic: { code?: string; cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(networkTransportErrorCode(cyclic)).toBeNull()
  })

  it('never throws or invokes accessors while inspecting a hostile error', () => {
    const throwingGetter = {}
    Object.defineProperty(throwingGetter, 'code', {
      get() {
        throw new Error('boom')
      }
    })
    expect(networkTransportErrorCode(throwingGetter)).toBeNull()

    let getterCalls = 0
    const sideEffectGetter = {}
    Object.defineProperty(sideEffectGetter, 'code', {
      get() {
        getterCalls += 1
        return 'ETIMEDOUT'
      }
    })
    expect(networkTransportErrorCode(sideEffectGetter)).toBeNull()
    expect(getterCalls).toBe(0)

    let trapCalls = 0
    const trapped = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          trapCalls += 1
          throw new Error('boom')
        },
        get: () => {
          trapCalls += 1
          throw new Error('boom')
        },
        has: () => {
          trapCalls += 1
          throw new Error('boom')
        }
      }
    )
    expect(networkTransportErrorCode(trapped)).toBeNull()
    expect(trapCalls).toBeGreaterThan(0)
  })

  it('ignores an inherited code so a polluted prototype cannot invent a reason', () => {
    class PollutedError extends Error {}
    Object.defineProperty(PollutedError.prototype, 'code', {
      value: 'ETIMEDOUT',
      configurable: true
    })
    expect(networkTransportErrorCode(new PollutedError('x'))).toBeNull()
    expect(networkTransportErrorCode(Object.create({ code: 'ETIMEDOUT' }))).toBeNull()
  })

  it('refuses anything outside the vocabulary so raw error text cannot escape', () => {
    expect(networkTransportErrorCode(fetchRejection('https://relay.example/v1/assign'))).toBeNull()
    expect(networkTransportErrorCode(fetchRejection('self_signed_cert_in_chain'))).toBeNull()
    expect(networkTransportErrorCode(new Error('SELF_SIGNED_CERT_IN_CHAIN'))).toBeNull()
    expect(networkTransportErrorCode({ code: 42 })).toBeNull()
    expect(networkTransportErrorCode(null)).toBeNull()
    expect(networkTransportErrorCode('ETIMEDOUT')).toBeNull()
  })
})
