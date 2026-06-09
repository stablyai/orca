import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_USAGE_EXAMPLES } from '@/lib/orchestration-usage-examples'
import { OrchestrationPane } from './OrchestrationPane'

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkill: () => ({
    installed: true,
    loading: false,
    error: null,
    skills: [
      {
        id: 'claude',
        name: 'orchestration',
        description: null,
        providers: ['claude'],
        sourceKind: 'home',
        sourceLabel: 'Claude home',
        rootPath: '/Users/test/.claude/skills',
        directoryPath: '/Users/test/.claude/skills/orchestration',
        skillFilePath: '/Users/test/.claude/skills/orchestration/SKILL.md',
        installed: true,
        fileCount: 1,
        updatedAt: null
      }
    ],
    refresh: vi.fn()
  })
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'codex', 'gemini'],
    isLoading: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

describe('OrchestrationPane', () => {
  it('keeps skill setup visible after install and shows agent coverage plus examples', () => {
    const markup = renderToStaticMarkup(<OrchestrationPane />)

    expect(markup).toContain('Orchestration skill')
    expect(markup).toContain('Installed')
    expect(markup).toContain('Agent coverage')
    expect(markup).toContain('Copy install command')
    expect(markup).toContain('detected agents')
    expect(markup).toContain('Gemini')
    expect(markup).toContain('Ready')
    expect(markup).toContain('How to use it')
    expect(markup).not.toContain('See examples')
    expect(ORCHESTRATION_USAGE_EXAMPLES).toHaveLength(5)
    for (const example of ORCHESTRATION_USAGE_EXAMPLES) {
      expect(markup).toContain(example.title)
    }
    expect(markup).toMatch(/<button\b[^>]*>[\s\S]*?Update[\s\S]*?<\/button>/)
    expect(markup).toContain('Re-check')
  })
})
