import { describe, expect, it } from 'vitest'
import { shouldEnableReactGrab } from './react-grab-dev-gate'

describe('shouldEnableReactGrab', () => {
  it('enables React Grab by default in dev builds', () => {
    expect(shouldEnableReactGrab({ dev: true })).toBe(true)
  })

  it('allows an explicit local opt-out in dev builds', () => {
    expect(shouldEnableReactGrab({ dev: true, enableFlag: 'false' })).toBe(false)
  })

  it('stays disabled outside dev builds', () => {
    expect(shouldEnableReactGrab({ dev: false })).toBe(false)
    expect(shouldEnableReactGrab({ dev: false, enableFlag: 'true' })).toBe(false)
  })
})
