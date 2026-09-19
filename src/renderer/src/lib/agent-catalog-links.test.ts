import { describe, expect, it } from 'vitest'
import { getAgentCatalog } from './agent-catalog'

describe('agent catalog documentation links', () => {
  it('keeps Claude links on the canonical documentation site', () => {
    const entries = new Map(getAgentCatalog().map((entry) => [entry.id, entry]))

    expect(entries.get('claude')?.homepageUrl).toBe('https://code.claude.com/docs')
    expect(entries.get('claude-agent-teams')?.homepageUrl).toBe(
      'https://code.claude.com/docs/en/agent-teams'
    )
  })

  it('links Mastra Code to its product site', () => {
    const entry = getAgentCatalog().find((agent) => agent.id === 'mastracode')

    expect(entry).toMatchObject({
      label: 'Mastra Code',
      cmd: 'mastracode',
      homepageUrl: 'https://code.mastra.ai/'
    })
  })
})
