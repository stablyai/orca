import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../shared/skills'
import {
  agentHasOrchestrationSkill,
  getOrchestrationSkillAgentStatuses
} from './orchestration-skill-coverage'

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'skill-1',
    name: 'orchestration',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/Users/test/.agents/skills',
    directoryPath: '/Users/test/.agents/skills/orchestration',
    skillFilePath: '/Users/test/.agents/skills/orchestration/SKILL.md',
    installed: true,
    fileCount: 1,
    updatedAt: null,
    ...overrides
  }
}

describe('orchestration skill agent coverage', () => {
  it('marks shared-path agents from the global ~/.agents/skills install', () => {
    const skills = [
      skill({
        providers: ['agent-skills'],
        sourceKind: 'home',
        rootPath: '/Users/test/.agents/skills',
        directoryPath: '/Users/test/.agents/skills/orchestration'
      })
    ]

    expect(getOrchestrationSkillAgentStatuses(skills, ['codex', 'gemini', 'droid'])).toEqual([
      { agent: 'codex', label: 'Codex', installed: true },
      { agent: 'gemini', label: 'Gemini', installed: true },
      { agent: 'droid', label: 'Droid', installed: true }
    ])
  })

  it('marks Claude from ~/.claude/skills without requiring a dedicated Codex path', () => {
    const skills = [
      skill({
        providers: ['claude'],
        sourceKind: 'home',
        rootPath: '/Users/test/.claude/skills',
        directoryPath: '/Users/test/.claude/skills/orchestration'
      })
    ]

    expect(agentHasOrchestrationSkill('claude', skills)).toBe(true)
    expect(agentHasOrchestrationSkill('codex', skills)).toBe(false)
    expect(agentHasOrchestrationSkill('gemini', skills)).toBe(false)
  })

  it('marks Codex from plugin cache installs', () => {
    expect(
      agentHasOrchestrationSkill('codex', [
        skill({
          providers: ['codex', 'agent-skills'],
          sourceKind: 'plugin',
          sourceLabel: 'Codex plugin cache',
          rootPath: '/Users/test/.codex/plugins/cache',
          directoryPath: '/Users/test/.codex/plugins/cache/vendor/orchestration'
        })
      ])
    ).toBe(true)
  })

  it('ignores repo-scoped orchestration installs', () => {
    expect(
      agentHasOrchestrationSkill('gemini', [
        skill({
          providers: ['agent-skills'],
          sourceKind: 'repo',
          rootPath: '/workspace/.agents/skills',
          directoryPath: '/workspace/.agents/skills/orchestration'
        })
      ])
    ).toBe(false)
  })

  it('matches orchestration by directory name when frontmatter uses a display name', () => {
    expect(
      agentHasOrchestrationSkill('claude', [
        skill({
          name: 'Orca Orchestration',
          providers: ['claude'],
          sourceKind: 'home',
          rootPath: '/Users/test/.claude/skills',
          directoryPath: '/Users/test/.claude/skills/orchestration'
        })
      ])
    ).toBe(true)
  })

  it('matches Windows skill paths', () => {
    expect(
      agentHasOrchestrationSkill('codex', [
        skill({
          providers: ['codex'],
          sourceKind: 'home',
          rootPath: 'C:\\Users\\test\\.codex\\skills',
          directoryPath: 'C:\\Users\\test\\.codex\\skills\\orchestration'
        })
      ])
    ).toBe(true)
  })
})
