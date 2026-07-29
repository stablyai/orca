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

  it('hands over the reinstall command when no location is at fault', () => {
    // Why: the only way to reach this with a bare out-of-date copy is the updater's own
    // record, which `skills update` can never converge — so the sentence has to give the
    // one command that does, not report a skip the user cannot act on.
    const reason = skippedReason([row(null)], 'orchestration')
    expect(reason).toContain('reports the skill as already up to date')
    expect(reason).toContain(
      'npx --yes skills add https://github.com/stablyai/orca --skill orchestration --global -y'
    )
  })

  it('never offers the reinstall for a copy that is ahead of this build', () => {
    // Why: reinstalling a newer copy rolls the user back to what this build ships.
    const reason = skippedReason([row('newer')], 'orchestration')
    expect(reason).toContain('later version')
    expect(reason).not.toContain('skills add')
  })

  it('keeps a placement blocker ahead of the record advice', () => {
    expect(skippedReason([row(null), row('unrecognized')], 'orchestration')).toContain(
      'doesn’t match the official version'
    )
  })

  it('falls back to the generic sentence when no skill name is available', () => {
    expect(skippedReason([row('current')])).toContain('left this skill out of the update')
    expect(skippedReason([])).toContain('left this skill out of the update')
  })
})
