import { describe, expect, it } from 'vitest'
import {
  SKILL_INSTALL_BUSY_FAILURE,
  SKILL_INSTALL_CANCELLED_FAILURE,
  SkillInstallFailureSchema
} from './skill-install-failure'

describe('skill install failure contract', () => {
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
})
