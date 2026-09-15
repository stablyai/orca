import { describe, expect, it } from 'vitest'
import { isDefinitiveAbsence } from './definitive-filesystem-absence'

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe('isDefinitiveAbsence', () => {
  it('accepts only the two codes that mean the path is not there', () => {
    expect(isDefinitiveAbsence(errno('ENOENT'))).toBe(true)
    expect(isDefinitiveAbsence(errno('ENOTDIR'))).toBe(true)
    for (const code of ['EPERM', 'EACCES', 'EBUSY', 'EIO', 'UNKNOWN', 'EEXIST']) {
      expect(isDefinitiveAbsence(errno(code))).toBe(false)
    }
  })

  it('is total over every rejection shape a catch block can receive', () => {
    expect(isDefinitiveAbsence(null)).toBe(false)
    expect(isDefinitiveAbsence(undefined)).toBe(false)
    expect(isDefinitiveAbsence('ENOENT')).toBe(false)
    expect(isDefinitiveAbsence(Object.create(null))).toBe(false)
    expect(isDefinitiveAbsence({ code: Symbol('ENOENT') })).toBe(false)
  })

  it('does not throw out of the classifier when reading the code throws', () => {
    // The predicate exists to keep a failed observation from becoming a verdict.
    // Throwing here would escape the fail-closed path it is guarding.
    const hostile = {
      get code(): string {
        throw new Error('nope')
      }
    }
    expect(() => isDefinitiveAbsence(hostile)).not.toThrow()
    expect(isDefinitiveAbsence(hostile)).toBe(false)
  })

  it('does not throw for a Proxy whose traps reject inspection', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('nope')
        },
        getPrototypeOf() {
          throw new Error('nope')
        }
      }
    )
    expect(() => isDefinitiveAbsence(hostile)).not.toThrow()
    expect(isDefinitiveAbsence(hostile)).toBe(false)
  })
})
