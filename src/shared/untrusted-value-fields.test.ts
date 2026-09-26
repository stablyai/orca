import { describe, expect, it } from 'vitest'
import {
  readUntrustedBoolean,
  readUntrustedExitCode,
  readUntrustedString
} from './untrusted-value-fields'

/**
 * This module is the single funnel every ownership site reads through, so the
 * hostile shapes are pinned here once rather than at each call site.
 */
function throwingGetter(field: string, base: Record<string, unknown> = {}): object {
  const target: Record<string, unknown> = { ...base }
  Object.defineProperty(target, field, {
    get(): never {
      throw new Error('accessor exploded')
    },
    enumerable: true
  })
  return target
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({ code: 'ENOENT', ran: true, timedOut: false }, {})
  revoke()
  return proxy
}

const hostile: [string, () => unknown][] = [
  ['null', () => null],
  ['undefined', () => undefined],
  ['a string', () => 'ENOENT'],
  ['a number', () => 7],
  ['a symbol', () => Symbol('ENOENT')],
  ['a throwing getter', () => throwingGetter('code')],
  ['a revoked proxy', () => revokedProxy()],
  [
    'a proxy whose get trap throws',
    () =>
      new Proxy(
        {},
        {
          get(): never {
            throw new Error('trap exploded')
          }
        }
      )
  ]
]

describe.each(hostile)('reading a field off %s', (_label, build) => {
  it('never throws and never answers', () => {
    const value = build()

    expect(() => readUntrustedString(value, 'code')).not.toThrow()
    expect(() => readUntrustedBoolean(value, 'ran')).not.toThrow()
    expect(() => readUntrustedExitCode(value, 'code')).not.toThrow()
    expect(readUntrustedString(value, 'code')).toBeUndefined()
    expect(readUntrustedBoolean(value, 'ran')).toBeUndefined()
    expect(readUntrustedExitCode(value, 'code')).toBeUndefined()
  })
})

describe('reading well-formed fields', () => {
  it('returns strings only when the field is a string', () => {
    expect(readUntrustedString({ code: 'ENOENT' }, 'code')).toBe('ENOENT')
    expect(readUntrustedString({ code: 2 }, 'code')).toBeUndefined()
    expect(readUntrustedString({ code: ['ENOENT'] }, 'code')).toBeUndefined()
  })

  it('returns booleans only when the field is a boolean', () => {
    expect(readUntrustedBoolean({ timedOut: true }, 'timedOut')).toBe(true)
    expect(readUntrustedBoolean({ timedOut: false }, 'timedOut')).toBe(false)
    expect(readUntrustedBoolean({ timedOut: 'true' }, 'timedOut')).toBeUndefined()
    expect(readUntrustedBoolean({ timedOut: 1 }, 'timedOut')).toBeUndefined()
  })

  it('keeps a null exit code distinct from an unreadable one', () => {
    // `null` means "killed by a signal", which is a real answer; `undefined`
    // means the field could not be read at all.
    expect(readUntrustedExitCode({ code: null }, 'code')).toBeNull()
    expect(readUntrustedExitCode({ code: 0 }, 'code')).toBe(0)
    expect(readUntrustedExitCode({ code: 41 }, 'code')).toBe(41)
    expect(readUntrustedExitCode({}, 'code')).toBeUndefined()
    expect(readUntrustedExitCode({ code: '41' }, 'code')).toBeUndefined()
    expect(readUntrustedExitCode({ code: Number.NaN }, 'code')).toBeUndefined()
  })

  it('reads through a function, which is also a property bag', () => {
    const carrier = Object.assign(() => undefined, { code: 'ENOTDIR' })

    expect(readUntrustedString(carrier, 'code')).toBe('ENOTDIR')
  })
})
