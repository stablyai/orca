import { describe, expect, it } from 'vitest'
import {
  MAX_SKILL_DELETE_BATCH,
  SkillDeletePlanSchema,
  SkillDeleteRequestSchema,
  SkillDeleteResultSchema
} from './skill-delete-contract'

const SKILL = {
  id: 'skill-id',
  directoryPath: '/root/demo',
  skillFilePath: '/root/demo/SKILL.md',
  name: 'demo',
  updatedAt: 1
}

describe('SkillDeleteRequestSchema', () => {
  it('accepts a request with no target, which is what the page sends', () => {
    expect(SkillDeleteRequestSchema.parse({ operationId: 'op', skills: [SKILL] })).toEqual({
      operationId: 'op',
      skills: [SKILL]
    })
  })

  it('rejects an unknown top-level field rather than ignoring it', () => {
    // Deliberately strict: an old host must refuse a field that would change
    // what gets deleted, not silently drop it.
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

describe('plan and result schemas', () => {
  it('carries a typed block reason so the band can group without string matching', () => {
    const plan = SkillDeletePlanSchema.parse({
      operationId: 'op',
      skills: [
        {
          id: 'a',
          name: 'demo',
          canonicalPath: '/root/demo/SKILL.md',
          placements: [],
          blocked: 'bundled'
        }
      ]
    })
    expect(plan.skills[0].blocked).toBe('bundled')
  })

  it('rejects a block reason outside the shared vocabulary', () => {
    expect(() =>
      SkillDeletePlanSchema.parse({
        operationId: 'op',
        skills: [{ id: 'a', name: 'demo', canonicalPath: '/p', placements: [], blocked: 'because' }]
      })
    ).toThrow()
  })

  it('has no `unsupported` status, because such a delete is never issued', () => {
    expect(() =>
      SkillDeleteResultSchema.parse({
        operationId: 'op',
        skills: [{ id: 'a', name: 'demo', status: 'unsupported', removedPaths: [] }]
      })
    ).toThrow()
  })

  it('accepts a partial result carrying the staged paths', () => {
    const result = SkillDeleteResultSchema.parse({
      operationId: 'op',
      skills: [
        {
          id: 'a',
          name: 'demo',
          status: 'partial',
          removedPaths: [],
          stagedPaths: ['/root/.demo.orca-skill-delete-1']
        }
      ]
    })
    expect(result.skills[0].stagedPaths).toHaveLength(1)
  })
})
