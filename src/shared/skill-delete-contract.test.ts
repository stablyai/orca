import { describe, expect, it } from 'vitest'
import { MAX_SKILL_DELETE_BATCH, SkillDeleteRequestSchema } from './skill-delete-contract'

const SKILL = {
  id: 'skill-id',
  directoryPath: '/root/demo',
  skillFilePath: '/root/demo/SKILL.md',
  name: 'demo',
  updatedAt: 1
}

describe('SkillDeleteRequestSchema', () => {
  it('rejects an unknown top-level field rather than ignoring it', () => {
    // Old hosts must reject delete-affecting unknown fields instead of silently dropping them.
    expect(() =>
      SkillDeleteRequestSchema.parse({ operationId: 'op', skills: [SKILL], force: true })
    ).toThrow()
  })

  it('strips unknown keys inside the nested discovery target', () => {
    const parsed = SkillDeleteRequestSchema.parse({
      operationId: 'op',
      target: { runtime: 'host', somethingNew: 1 },
      skills: [SKILL]
    })
    expect(parsed.target).toEqual({ runtime: 'host' })
  })

  it('keeps a null updatedAt, which the host fails closed on', () => {
    const parsed = SkillDeleteRequestSchema.parse({
      operationId: 'op',
      skills: [{ ...SKILL, updatedAt: null }]
    })
    expect(parsed.skills[0].updatedAt).toBeNull()
  })

  it('refuses an empty or oversized batch', () => {
    expect(() => SkillDeleteRequestSchema.parse({ operationId: 'op', skills: [] })).toThrow()
    expect(() =>
      SkillDeleteRequestSchema.parse({
        operationId: 'op',
        skills: Array.from({ length: MAX_SKILL_DELETE_BATCH + 1 }, () => SKILL)
      })
    ).toThrow()
  })
})
