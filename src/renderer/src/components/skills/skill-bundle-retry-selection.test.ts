import { describe, expect, it } from 'vitest'
import type { SkillBundleInstallResult } from '../../../../shared/skill-bundle-install-contract'
import { retryableSkillIds } from './skill-bundle-retry-selection'

function result(): SkillBundleInstallResult {
  return {
    operationId: 'operation_1',
    packageId: 'package_1',
    versionId: 'version_1',
    bundleDigest: 'a'.repeat(64),
    status: 'partial',
    skills: [
      {
        skillId: 'partial-placement',
        name: 'partial-placement',
        digest: 'b'.repeat(64),
        status: 'installed',
        placements: [
          {
            provider: 'claude',
            path: '/skills/partial-placement',
            topology: 'provider-alias',
            status: 'skipped'
          }
        ]
      },
      {
        skillId: 'complete-skill',
        name: 'complete-skill',
        digest: 'c'.repeat(64),
        status: 'installed',
        placements: []
      }
    ]
  }
}

describe('bundle retry selection', () => {
  it('includes skills whose provider placement is incomplete', () => {
    expect([...retryableSkillIds(result())]).toEqual(['partial-placement'])
  })

  it('includes a skill whose top-level result failed', () => {
    const failedResult = result()
    failedResult.skills = [
      {
        skillId: 'failed-skill',
        name: 'failed-skill',
        digest: 'd'.repeat(64),
        status: 'failed',
        placements: []
      }
    ]

    expect([...retryableSkillIds(failedResult)]).toEqual(['failed-skill'])
  })
})
