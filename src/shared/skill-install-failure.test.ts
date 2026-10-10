import { describe, expect, it } from 'vitest'
import {
  SKILL_INSTALL_BUSY_FAILURE,
  SKILL_INSTALL_CANCELLED_FAILURE,
  SkillInstallFailureCategorySchema,
  SkillInstallFailureSchema,
  classifySkillInstallFailureCode
} from './skill-install-failure'

describe('skill install failure contract', () => {
  it('freezes every V1 failure category', () => {
    expect(SkillInstallFailureCategorySchema.options).toEqual([
      'admission',
      'transport',
      'archive',
      'filesystem',
      'conflict',
      'recovery',
      'provider-placement',
      'compatibility',
      'cancelled'
    ])
  })

  it('keeps retryability explicit and rejects unstable codes', () => {
    expect(SkillInstallFailureSchema.parse(SKILL_INSTALL_BUSY_FAILURE).retryable).toBe(true)
    expect(SkillInstallFailureSchema.parse(SKILL_INSTALL_CANCELLED_FAILURE).category).toBe(
      'cancelled'
    )
    expect(() =>
      SkillInstallFailureSchema.parse({
        category: 'filesystem',
        code: 'EBUSY: /private/path',
        retryable: true
      })
    ).toThrow()
  })

  it.each([
    ['skill-install-workspace-required', 'admission'],
    ['skill-download-transport-failed', 'transport'],
    ['skill-package-tar-truncated', 'archive'],
    ['skill-install-busy', 'filesystem'],
    ['skill-install-conflict-modified', 'conflict'],
    ['skill-install-recovery-conflict', 'recovery'],
    ['skill-placement-create-failed', 'provider-placement'],
    ['skill-install-ssh-update-required', 'compatibility'],
    ['skill-install-cancelled', 'cancelled']
  ] as const)('classifies %s as %s', (code, category) => {
    expect(classifySkillInstallFailureCode(code)?.category).toBe(category)
  })
})
