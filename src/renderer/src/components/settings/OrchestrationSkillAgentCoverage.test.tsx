import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'

const useDetectedAgents = vi.fn(() => ({
  detectedIds: ['claude', 'codex'],
  isLoading: false,
  isRefreshing: false,
  refresh: vi.fn()
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: (...args: unknown[]) => useDetectedAgents(...(args as []))
}))

describe('OrchestrationSkillAgentCoverage', () => {
  it('shows each detected agent with an explicit skill status', () => {
    const markup = renderToStaticMarkup(
      <OrchestrationSkillAgentCoverage
        loading={false}
        sources={[
          {
            id: 'claude-home',
            label: 'Claude home',
            path: '/Users/test/.claude/skills',
            sourceKind: 'home',
            providers: ['claude'],
            owner: 'claude',
            exists: true
          }
        ]}
        skills={[
          {
            id: 'claude-skill',
            name: 'orchestration',
            description: null,
            providers: ['claude'],
            sourceKind: 'home',
            sourceLabel: 'Claude home',
            rootPath: '/Users/test/.claude/skills',
            directoryPath: '/Users/test/.claude/skills/orchestration',
            skillFilePath: '/Users/test/.claude/skills/orchestration/SKILL.md',
            installed: true,
            updatedAt: null
          }
        ]}
      />
    )

    expect(markup).toContain('Claude')
    expect(markup).toContain('Codex')
    expect(markup).toContain('Ready')
    expect(markup).toContain('Missing')
    expect(markup).not.toContain('View details')
    // Why: an omitted target reads as "host unknown", which pins detectedIds to
    // null and leaves the widget spinning forever.
    expect(useDetectedAgents).toHaveBeenCalledWith({ kind: 'local' })
  })
})
