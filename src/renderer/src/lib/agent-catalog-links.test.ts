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

  it('lists Vercel fx once with its interactive command and homepage', () => {
    const entries = getAgentCatalog().filter((entry) => entry.id === 'fx')

    expect(entries).toEqual([
      {
        id: 'fx',
        label: 'Vercel fx',
        cmd: 'fx',
        homepageUrl: 'https://fx.sh'
      }
    ])
  })
})
