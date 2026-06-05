import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OrchestrationPane } from './OrchestrationPane'

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['global'],
  useInstalledAgentSkill: () => ({
    installed: true,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))

describe('OrchestrationPane', () => {
  it('shows skill install status without a separate enable switch', () => {
    const markup = renderToStaticMarkup(<OrchestrationPane />)

    expect(markup).toContain('Orchestration skill')
    expect(markup).toContain('Installed')
    expect(markup).not.toContain('rounded-xl')
    expect(markup).not.toMatch(/<button\b[^>]*>[\s\S]*?Install[\s\S]*?<\/button>/)
    expect(markup).not.toContain('role="switch"')
  })
})
