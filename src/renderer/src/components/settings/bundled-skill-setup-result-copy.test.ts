import { describe, expect, it } from 'vitest'
import { doneResult, planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { bundledSkillSetupChanges } from './bundled-skill-setup-copy'
import { skillInstallResultLine } from './bundled-skill-setup-result-copy'

function resultLine(plan: ReturnType<typeof planOf>): string {
  const result = doneResult(plan)
  return skillInstallResultLine(result, bundledSkillSetupChanges(plan, result))
}

describe('setup result details', () => {
  it('reports the backup only when a replacement finished', () => {
    const plan = planOf([sharedEntry('orca-cli', 'replace')])
    const result = doneResult(plan)
    expect(resultLine(plan)).toBe('Replaced · Your copy was saved as a backup')
    result.skills[0].ops[0].status = 'failed'
    expect(skillInstallResultLine(result, bundledSkillSetupChanges(plan, result))).toBe(
      'Needs attention'
    )
  })
})
