import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../skills/discovery/skills'
import { isNativeChatSkillForAgent } from './native-chat-skill-visibility'

const AGENTS_HOME = '/home/u/.agents/skills'
const CLAUDE_HOME = '/home/u/.claude/skills'
const KIRO_HOME = '/home/u/.kiro/skills'

function source(path: string, owner: SkillDiscoverySource['owner']): SkillDiscoverySource {
  return { id: path, label: path, path, sourceKind: 'home', providers: [], owner, exists: true }
}

const result = {
  sources: [source(AGENTS_HOME, null), source(CLAUDE_HOME, 'claude'), source(KIRO_HOME, 'kiro')]
}

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

describe('isNativeChatSkillForAgent', () => {
  it('hides shared .agents/skills from Claude and Kiro unless linked into their own root', () => {
    expect(isNativeChatSkillForAgent('claude', skill([AGENTS_HOME]), result)).toBe(false)
    expect(isNativeChatSkillForAgent('claude', skill([AGENTS_HOME, CLAUDE_HOME]), result)).toBe(
      true
    )
    expect(isNativeChatSkillForAgent('kiro', skill([AGENTS_HOME]), result)).toBe(false)
    expect(isNativeChatSkillForAgent('kiro', skill([AGENTS_HOME, KIRO_HOME]), result)).toBe(true)
    expect(isNativeChatSkillForAgent('kiro', skill([KIRO_HOME]), result)).toBe(true)
  })
})
