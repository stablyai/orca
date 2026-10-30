import { describe, expect, it } from 'vitest'
import type { BundledSkillOp } from '../../../shared/bundled-skill-plan'
import {
  planEntry,
  planOf,
  planOp
} from '../components/skills/bundled-skill-plan-fixtures.test-support'
import {
  getSkillFreshnessDisplayStatus,
  hasSkillCopyNeedingAttention
} from './skill-freshness-display-status'

const SKILL_NAME = 'orca-cli'
const SHARED = `/home/u/.agents/skills/${SKILL_NAME}`
const CLAUDE = `/home/u/.claude/skills/${SKILL_NAME}`

function planWith(...ops: BundledSkillOp[]) {
  return planOf([planEntry(SKILL_NAME, ops)])
}

describe('getSkillFreshnessDisplayStatus', () => {
  it('flags an edited copy left alone, and an interrupted update to repair', () => {
    const edited = planWith(
      planOp('keep', SHARED),
      planOp('leave', CLAUDE, { reason: 'edited', replaceable: true })
    )
    expect(getSkillFreshnessDisplayStatus(edited, SKILL_NAME)).toBe('needs-attention')
    expect(hasSkillCopyNeedingAttention(edited, SKILL_NAME)).toBe(true)

    const repair = planWith(planOp('restore', SHARED))
    expect(getSkillFreshnessDisplayStatus(repair, SKILL_NAME)).toBe('needs-attention')
  })

  it("does not flag someone else's same-named skill", () => {
    const plan = planWith(
      planOp('keep', SHARED),
      planOp('leave', CLAUDE, { reason: 'other', replaceable: true })
    )
    expect(getSkillFreshnessDisplayStatus(plan, SKILL_NAME)).toBe('up-to-date')
    expect(hasSkillCopyNeedingAttention(plan, SKILL_NAME)).toBe(false)
  })

  it('reads an unknown op kind from a newer host as needing attention', () => {
    const plan = planWith({
      ...planOp('keep', SHARED),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Simulates a newer host's op kind this build does not know.
      kind: 'teleport' as BundledSkillOp['kind']
    })
    expect(getSkillFreshnessDisplayStatus(plan, SKILL_NAME)).toBe('needs-attention')
  })
})
