import { describe, expect, it } from 'vitest'
import {
  fishRequirementViolation,
  REQUIRE_FISH_ENV_VAR,
  resolveFishBinary,
  type FishBinaryLookup
} from './fish-binary-requirement'

const FOUND: FishBinaryLookup = { available: true, path: '/usr/bin/fish', majorVersion: 4 }
const MISSING: FishBinaryLookup = {
  available: false,
  path: null,
  majorVersion: 0,
  reason: 'no fish binary on PATH'
}

describe('fishRequirementViolation', () => {
  it('lets a missing fish skip when the requirement is not set', () => {
    expect(fishRequirementViolation(MISSING, {})).toBeNull()
    expect(fishRequirementViolation(MISSING, { [REQUIRE_FISH_ENV_VAR]: '0' })).toBeNull()
  })

  // The #9993 guard is CI's only end-to-end coverage; a skip there is a silent gap.
  it('reports a violation naming the reason when CI requires fish and it is absent', () => {
    const violation = fishRequirementViolation(MISSING, { [REQUIRE_FISH_ENV_VAR]: '1' })
    expect(violation).toContain(REQUIRE_FISH_ENV_VAR)
    expect(violation).toContain('no fish binary on PATH')
  })

  it('reports no violation when fish is present, requirement set or not', () => {
    expect(fishRequirementViolation(FOUND, { [REQUIRE_FISH_ENV_VAR]: '1' })).toBeNull()
    expect(fishRequirementViolation(FOUND, {})).toBeNull()
  })
})

describe('resolveFishBinary', () => {
  it('treats an installed fish below the floor as unavailable, with the version in the reason', () => {
    const lookup = resolveFishBinary(Number.MAX_SAFE_INTEGER)
    if (lookup.available) {
      throw new Error('no fish can satisfy an unreachable version floor')
    }
    // Only when a fish is actually installed does the reason describe a version.
    if (lookup.majorVersion > 0) {
      expect(lookup.reason).toContain(`fish ${Number.MAX_SAFE_INTEGER}+ required`)
    }
  })

  it('never reports a path on Windows', () => {
    if (process.platform !== 'win32') {
      return
    }
    expect(resolveFishBinary().path).toBeNull()
  })
})
