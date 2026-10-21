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
    expect(skippedReason([row('duplicate'), row('read-only')])).toContain('read-only location')
    expect(skippedReason([row('duplicate'), row('external-link')])).toContain(
      'pointing outside Orca’s skill folders'
    )
  })

  it('does not let a project copy outrank the placement that blocked the update', () => {
    // Why by row and not by chip: the scan-limit sentinel is also project-scoped and
    // carries 'inaccessible', which would otherwise claim a read failure Orca never hit.
    expect(skippedReason([row('duplicate'), projectRow()])).toContain('separate copy')
    expect(skippedReason([row('duplicate'), projectRow('inaccessible')])).toContain('separate copy')
  })

  it('explains a project copy when that is the only location there is', () => {
    expect(skippedReason([projectRow()])).toContain('This is a project skill, not a global one')
  })

  it('falls back to the generic sentence when no location is at fault', () => {
    expect(skippedReason([row('current')])).toContain('left this skill out of the update')
    expect(skippedReason([row(null)])).toContain('left this skill out of the update')
    expect(skippedReason([])).toContain('left this skill out of the update')
  })
})
