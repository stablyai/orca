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

  // Why: Object.hasOwn coerces its key, so a guard typed (x: string) admits ['missing'] — whose
  // toString matches a handled key — and the value then falls straight back out of the switch.
  // This is the P1 found in review on #15002; it is the reason the parameter is `unknown`.
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
