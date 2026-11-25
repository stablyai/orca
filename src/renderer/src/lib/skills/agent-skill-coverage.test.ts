import { describe, expect, it } from 'vitest'
import type {
  DiscoveredSkill,
  SkillDiscoverySource
} from '../../../../shared/skills/discovery/skills'
import { agentReadsSkill } from './agent-skill-coverage'

const AGENTS_HOME = '/home/u/.agents/skills'
const CLAUDE_HOME = '/home/u/.claude/skills'

function source(path: string, owner: SkillDiscoverySource['owner']): SkillDiscoverySource {
  return { id: path, label: path, path, sourceKind: 'home', providers: [], owner, exists: true }
}

const sources = [source(AGENTS_HOME, null), source(CLAUDE_HOME, 'claude')]

function skill(rootPaths: string[]): DiscoveredSkill {
  return {
    id: rootPaths.join(','),
    name: 'demo-save',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'test',
    rootPath: rootPaths[0],
    rootPaths,
    directoryPath: `${rootPaths[0]}/demo-save`,
    skillFilePath: `${rootPaths[0]}/demo-save/SKILL.md`,
    installed: true,
    updatedAt: null
  }
}

describe('agentReadsSkill', () => {
  it('applies the Claude shared-root rule to Claude agent teams', () => {
    expect(agentReadsSkill('claude-agent-teams', skill([AGENTS_HOME]), sources)).toBe(false)
    expect(agentReadsSkill('claude-agent-teams', skill([AGENTS_HOME, CLAUDE_HOME]), sources)).toBe(
      true
    )
  })
})
