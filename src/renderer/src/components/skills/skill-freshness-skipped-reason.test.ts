import { describe, expect, it } from 'vitest'
import type { SkillLocationRow } from './skill-freshness-grouping'
import { skippedReason } from './skill-freshness-skipped-reason'

function row(
  chip: SkillLocationRow['chip'],
  path = `/home/.agents/skills/${chip}`
): SkillLocationRow {
  return { id: `row-${chip}-${path}`, path, chip, participatesInGlobalFreshness: true }
}

/** A project's own copy: listed, but never judged by the global update. */
function projectRow(chip: SkillLocationRow['chip'] = 'in-a-repo'): SkillLocationRow {
  return {
    ...row(chip, '/home/projects/work/.agents/skills/orchestration'),
    participatesInGlobalFreshness: false
  }
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
      'npx skills add https://github.com/stablyai/orca --skill orchestration --global'
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

  it('keeps the reinstall remedy when a project copy sits beside the blocked global copy', () => {
    // The reported shape: a bare out-of-date global copy the updater's record cannot
    // converge, plus the user's own project copy. Letting the project copy explain the
    // skip swapped the one runnable command for advice about a copy Orca never judged.
    const reason = skippedReason([row(null), projectRow()], 'orchestration')
    expect(reason).toContain('reports the skill as already up to date')
    expect(reason).toContain('skills add')
    expect(reason).not.toContain('This is a project skill')
  })

  it('does not let a project copy outrank the placement that blocked the update', () => {
    // Why by row and not by chip: the scan-limit sentinel is also project-scoped and
    // carries 'inaccessible', which would otherwise claim a read failure Orca never hit.
    expect(skippedReason([row('duplicate'), projectRow()], 'orchestration')).toContain(
      'separate copy'
    )
    expect(
      skippedReason([row('duplicate'), projectRow('inaccessible')], 'orchestration')
    ).toContain('separate copy')
  })

  it('explains a project copy when that is the only location there is', () => {
    // Why the fallback exists: the sentence stays total. With nothing else to point at,
    // "Orca only updates your global skills" is the honest reason.
    expect(skippedReason([projectRow()], 'orchestration')).toContain(
      'This is a project skill, not a global one'
    )
  })

  it('falls back to the generic sentence when no skill name is available', () => {
    expect(skippedReason([row('current')])).toContain('left this skill out of the update')
    expect(skippedReason([])).toContain('left this skill out of the update')
  })
})
