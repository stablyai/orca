import { describe, expect, it } from 'vitest'
import { isHandledWireDiscriminant } from './handled-wire-discriminant'

const HANDLED: Record<'missing' | 'unavailable', true> = {
  missing: true,
  unavailable: true
}

describe('isHandledWireDiscriminant', () => {
  it('admits the handled members', () => {
    expect(isHandledWireDiscriminant('missing', HANDLED)).toBe(true)
    expect(isHandledWireDiscriminant('unavailable', HANDLED)).toBe(true)
  })

  it('rejects a member this build has never heard of', () => {
    expect(isHandledWireDiscriminant('permission-denied', HANDLED)).toBe(false)
  })

  // Object.hasOwn coerces arrays such as [missing] to handled keys; require unknown input and reject non-strings before the switch (#15002).
  it('rejects a non-string the wire can carry', () => {
    for (const value of [['missing'], null, undefined, 0, true, { missing: true }, Symbol('x')]) {
      expect(isHandledWireDiscriminant(value, HANDLED), String(value)).toBe(false)
    }
  })

  // Why: hasOwn, not `in` — inherited keys are not handled members.
  it('does not admit inherited object keys', () => {
    expect(isHandledWireDiscriminant('toString', HANDLED)).toBe(false)
    expect(isHandledWireDiscriminant('constructor', HANDLED)).toBe(false)
    expect(isHandledWireDiscriminant('__proto__', HANDLED)).toBe(false)
  })
})
