import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../shared/skills'
import { getLinearAgentSkillUpdateTarget } from './linear-agent-skill-update-target'

function skill(name: string): DiscoveredSkill {
  return {
    id: name,
    name,
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/home/test/.agents/skills',
    directoryPath: `/home/test/.agents/skills/${name}`,
    skillFilePath: `/home/test/.agents/skills/${name}/SKILL.md`,
    installed: true,
    updatedAt: null
  }
}

describe('getLinearAgentSkillUpdateTarget', () => {
  it('targets the canonical skill for missing, canonical, and dual-name installs', () => {
    expect(getLinearAgentSkillUpdateTarget([], false)).toEqual({ skillName: 'orca-linear' })
    expect(getLinearAgentSkillUpdateTarget([skill('orca-linear')], true)).toEqual({
      skillName: 'orca-linear'
    })
    expect(
      getLinearAgentSkillUpdateTarget([skill('orca-linear'), skill('linear-tickets')], true)
    ).toEqual({ skillName: 'orca-linear' })
  })

  it('keeps the update and freshness identity on a legacy-only install', () => {
    expect(getLinearAgentSkillUpdateTarget([skill('linear-tickets')], true)).toEqual({
      skillName: 'linear-tickets'
    })
  })
})
