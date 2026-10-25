import { describe, expect, it } from 'vitest'
import { profileStateBuildCompatibilityError } from './profile-state-build-compatibility'

describe('SQLite profile build selection', () => {
  it.each(['1.4.213', '1.4.214-rc.0', '1.4.213-adhoc.20260926034644', 'invalid'])(
    'refuses %s before it can read stale JSON',
    (version) => {
      expect(profileStateBuildCompatibilityError('1.4.221', version)).toContain('--profile-id')
    }
  )

  it.each(['1.4.214', '1.4.215-adhoc.20260927000000', '1.4.220'])(
    'allows SQLite-capable %s, including older builds',
    (version) => {
      expect(profileStateBuildCompatibilityError('1.4.221', version)).toBeNull()
    }
  )

  it('leaves JSON-era build selection unaffected', () => {
    expect(profileStateBuildCompatibilityError('1.4.200', '1.4.199')).toBeNull()
  })
})
