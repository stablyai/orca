import { describe, expect, it } from 'vitest'
import {
  agentLocation,
  blockedPlan,
  currentPlan,
  freshnessInventory,
  sharedLocation,
  skillPlan,
  updatablePlan
} from './bundled-skill-plan-fixtures'
import {
  getSkillFreshnessDisplayStatus,
  hasSkillCopyNeedingAttention
} from './skill-freshness-display-status'

describe('skill freshness display status', () => {
  it('reads the install plan: update, current, left as it is', () => {
    const inventory = freshnessInventory(
      updatablePlan('orca-cli'),
      currentPlan('orchestration'),
      blockedPlan('computer-use')
    )

    expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('update-available')
    expect(getSkillFreshnessDisplayStatus(inventory, 'orchestration')).toBe('up-to-date')
    expect(getSkillFreshnessDisplayStatus(inventory, 'computer-use')).toBe('needs-attention')
  })

  it('reports presence only before a scan or for a skill with no plan', () => {
    expect(getSkillFreshnessDisplayStatus(null, 'orca-cli')).toBe('installed')
    expect(getSkillFreshnessDisplayStatus(freshnessInventory(), 'orca-cli')).toBe('installed')
  })

  it('offers the update for a skills CLI copy in an agent folder the install takes over', () => {
    const plan = skillPlan('orca-cli', [
      sharedLocation('orca-cli', 'install'),
      agentLocation('orca-cli', 'replace')
    ])

    expect(getSkillFreshnessDisplayStatus(freshnessInventory(plan), 'orca-cli')).toBe(
      'update-available'
    )
  })

  it('never offers to install a skill whose only copy is someone else’s', () => {
    const plan = skillPlan('orca-cli', [
      sharedLocation('orca-cli', 'install'),
      agentLocation('orca-cli', 'leave', 'not-installed-by-orca')
    ])

    expect(getSkillFreshnessDisplayStatus(freshnessInventory(plan), 'orca-cli')).toBe(
      'needs-attention'
    )
  })

  it('marks attention whenever the install leaves a copy, even beside an update', () => {
    const plan = skillPlan('orca-cli', [
      sharedLocation('orca-cli', 'update'),
      agentLocation('orca-cli', 'leave', 'read-only')
    ])
    const inventory = freshnessInventory(plan, updatablePlan('orchestration'))

    expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('update-available')
    expect(hasSkillCopyNeedingAttention(inventory, 'orca-cli')).toBe(true)
    expect(hasSkillCopyNeedingAttention(inventory, 'orchestration')).toBe(false)
  })
})
