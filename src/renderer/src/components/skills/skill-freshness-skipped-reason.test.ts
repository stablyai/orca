import { describe, expect, it } from 'vitest'
import type { SkillLocationRow } from './skill-freshness-grouping'
import { skippedReason } from './skill-freshness-skipped-reason'

function row(
  chip: SkillLocationRow['chip'],
  path = `/home/.agents/skills/${chip}`
): SkillLocationRow {
  return { id: `row-${chip}-${path}`, path, chip }
}

describe('skippedReason', () => {
  it('names the stale duplicate the global command cannot reach', () => {
    const reason = skippedReason([row('current'), row('duplicate')])
    expect(reason).toContain('separate copy')
    expect(reason).toContain('only refreshes the main copy')
  })

  it('leads with the harder blocker when several placements are off', () => {
    // Why: an edited copy is the real cause; the duplicate is the lesser symptom, and
    // telling the user to remove the duplicate would not unblock the update.
    expect(skippedReason([row('duplicate'), row('unrecognized')])).toContain(
      'doesn’t match the official version'
    )
    expect(skippedReason([row('duplicate'), row('read-only')])).toContain('read-only location')
  })

  it('falls back to the generic sentence when nothing is blocking', () => {
    expect(skippedReason([row('current')])).toContain('left this skill out of the update')
    expect(skippedReason([])).toContain('left this skill out of the update')
  })
})
