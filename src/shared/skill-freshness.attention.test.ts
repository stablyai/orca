import { describe, expect, it } from 'vitest'
import {
  isSkillCopyNeedingAttention,
  type SkillFreshnessInstallation
} from './skill-freshness'

function installation(
  overrides: Partial<SkillFreshnessInstallation> &
    Pick<SkillFreshnessInstallation, 'topology' | 'status'>
): SkillFreshnessInstallation {
  return {
    id: 'i1',
    name: 'orca-cli',
    rootId: 'home-claude',
    providers: [],
    sourceKind: 'home',
    sourceLabel: 'test',
    unresolvedPath: '/tmp/skill',
    resolvedPath: '/tmp/skill',
    physicalIdentity: 'abc',
    installedReleaseRevision: 1,
    installedAppVersion: '1.0.0',
    currentReleaseRevision: 2,
    currentPackageDigest: 'digest',
    currentAppVersion: '1.1.0',
    observedPackageDigest: 'old',
    errorCategory: null,
    ...overrides
  }
}

describe('isSkillCopyNeedingAttention', () => {
  it('treats outdated independent-copy as routine (not attention)', () => {
    // Issue #11455: Windows skill installs are independent-copy; outdated must
    // match the "Update available" pill, not the amber warning triangle.
    expect(
      isSkillCopyNeedingAttention(
        installation({ topology: 'independent-copy', status: 'outdated' })
      )
    ).toBe(false)
  })

  it('still treats outdated canonical-copy and provider-alias as routine', () => {
    expect(
      isSkillCopyNeedingAttention(
        installation({ topology: 'canonical-copy', status: 'outdated' })
      )
    ).toBe(false)
    expect(
      isSkillCopyNeedingAttention(
        installation({ topology: 'provider-alias', status: 'outdated' })
      )
    ).toBe(false)
  })

  it('flags unrecognized independent-copy as needing attention', () => {
    expect(
      isSkillCopyNeedingAttention(
        installation({ topology: 'independent-copy', status: 'unrecognized' })
      )
    ).toBe(true)
  })

  it('does not flag current independent-copy', () => {
    expect(
      isSkillCopyNeedingAttention(
        installation({ topology: 'independent-copy', status: 'current' })
      )
    ).toBe(false)
  })
})
