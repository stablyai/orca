import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../shared/skills'
import type { TuiAgent } from '../../../shared/types'
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

  it('marks each provider-home agent from its own global skills location', () => {
    const cases: { agent: TuiAgent; rootPath: string; directoryPath: string }[] = [
      {
        agent: 'grok',
        rootPath: '/Users/test/.grok/skills',
        directoryPath: '/Users/test/.grok/skills/orchestration'
      },
      {
        agent: 'opencode',
        rootPath: '/Users/test/.config/opencode/skills',
        directoryPath: '/Users/test/.config/opencode/skills/orchestration'
      },
      {
        agent: 'pi',
        rootPath: '/Users/test/.pi/agent/skills',
        directoryPath: '/Users/test/.pi/agent/skills/orchestration'
      },
      {
        agent: 'gemini',
        rootPath: '/Users/test/.gemini/skills',
        directoryPath: '/Users/test/.gemini/skills/orchestration'
      },
      {
        agent: 'antigravity',
        rootPath: '/Users/test/.gemini/antigravity/skills',
        directoryPath: '/Users/test/.gemini/antigravity/skills/orchestration'
      },
      {
        agent: 'cursor',
        rootPath: '/Users/test/.cursor/skills',
        directoryPath: '/Users/test/.cursor/skills/orchestration'
      }
    ]
    for (const { agent, rootPath, directoryPath } of cases) {
      const skills = [
        skill({ providers: ['agent-skills'], sourceKind: 'home', rootPath, directoryPath })
      ]
      expect(agentHasOrchestrationSkill(agent, skills)).toBe(true)
      // Why: a provider-home install must not leak coverage to unrelated agents.
      expect(agentHasOrchestrationSkill('claude', skills)).toBe(false)
    }
  })

  it('marks a multi-segment provider-home agent from a Windows-style path', () => {
    expect(
      agentHasOrchestrationSkill('opencode', [
        skill({
          providers: ['agent-skills'],
          sourceKind: 'home',
          rootPath: 'C:\\Users\\test\\.config\\opencode\\skills',
          directoryPath: 'C:\\Users\\test\\.config\\opencode\\skills\\orchestration'
        })
      ])
    ).toBe(true)
  })

  it('keeps Gemini and Antigravity distinct despite sharing the ~/.gemini root', () => {
    const geminiInstall = [
      skill({
        providers: ['agent-skills'],
        sourceKind: 'home',
        rootPath: '/Users/test/.gemini/skills',
        directoryPath: '/Users/test/.gemini/skills/orchestration'
      })
    ]
    const antigravityInstall = [
      skill({
        providers: ['agent-skills'],
        sourceKind: 'home',
        rootPath: '/Users/test/.gemini/antigravity/skills',
        directoryPath: '/Users/test/.gemini/antigravity/skills/orchestration'
      })
    ]

    // Why: `.gemini/skills` and `.gemini/antigravity/skills` are siblings, so a
    // segment matcher must not let one provider's install mark the other.
    expect(agentHasOrchestrationSkill('gemini', geminiInstall)).toBe(true)
    expect(agentHasOrchestrationSkill('antigravity', geminiInstall)).toBe(false)
    expect(agentHasOrchestrationSkill('antigravity', antigravityInstall)).toBe(true)
    expect(agentHasOrchestrationSkill('gemini', antigravityInstall)).toBe(false)
  })

  it('marks Claude Agent Teams from ~/.claude/skills like Claude Code', () => {
    const skills = [
      skill({
        providers: ['claude'],
        sourceKind: 'home',
        rootPath: '/Users/test/.claude/skills',
        directoryPath: '/Users/test/.claude/skills/orchestration'
      })
    ]

    expect(agentHasOrchestrationSkill('claude-agent-teams', skills)).toBe(true)
  })

  it('marks Windows skill paths', () => {
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
