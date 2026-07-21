import { describe, expect, it } from 'vitest'
import type {
  SkillFreshnessInstallation,
  SkillFreshnessInventory,
  SkillFreshnessStatus
} from '../../../shared/skill-freshness'
import { getSkillFreshnessDisplayStatus } from './skill-freshness-display-status'

const SKILL_NAME = 'orca-cli'

function placement(status: SkillFreshnessStatus, index = 0): SkillFreshnessInstallation {
  return {
    id: `${SKILL_NAME}-${index}`,
    name: SKILL_NAME,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: `/home/.agents/skills/${SKILL_NAME}-${index}`,
    resolvedPath: `/home/.agents/skills/${SKILL_NAME}-${index}`,
    physicalIdentity: `physical-${index}`,
    topology: 'canonical-copy',
    status,
    installedReleaseRevision: 1,
    installedAppVersion: '1.0.0',
    currentReleaseRevision: 2,
    currentPackageDigest: 'current',
    currentAppVersion: '2.0.0',
    observedPackageDigest: status === 'current' ? 'current' : 'other',
    errorCategory: null
  }
}

function inventory(
  installations: SkillFreshnessInstallation[],
  eligibleUpdateNames: string[] = []
): SkillFreshnessInventory {
  return { schemaVersion: 1, installations, eligibleUpdateNames, scannedAt: 1 }
}

describe('getSkillFreshnessDisplayStatus', () => {
  it('shows update available when the inventory authorizes an update', () => {
    expect(
      getSkillFreshnessDisplayStatus(inventory([placement('outdated')], [SKILL_NAME]), SKILL_NAME)
    ).toBe('update-available')
  })

  it('shows up to date only when every discovered placement is current', () => {
    expect(
      getSkillFreshnessDisplayStatus(
        inventory([placement('current'), placement('current', 1)]),
        SKILL_NAME
      )
    ).toBe('up-to-date')
  })

  it.each([
    ['before the inventory loads', null],
    ['when the inventory has no matching placement', inventory([])],
    [
      'when any placement is unrecognized',
      inventory([placement('current'), placement('unrecognized', 1)])
    ],
    ['when a placement is inaccessible', inventory([placement('inaccessible')])],
    ['when an outdated placement is not eligible', inventory([placement('outdated')])]
  ])('falls back to installed %s', (_scenario, value) => {
    expect(getSkillFreshnessDisplayStatus(value, SKILL_NAME)).toBe('installed')
  })
})
