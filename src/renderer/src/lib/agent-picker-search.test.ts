import { describe, expect, it } from 'vitest'
import {
  agentPickerBlankTerminalMatches,
  getAgentPickerCommandValue,
  searchAgentPickerEntries
} from './agent-picker-search'
import { AGENT_CATALOG, type AgentCatalogEntry } from './agent-catalog'

const agents = [
  entry('claude', 'Claude', 'claude'),
  entry('codex', 'Codex', 'codex'),
  entry('copilot', 'GitHub Copilot', 'copilot'),
  entry('opencode', 'OpenCode', 'opencode'),
  entry('mistral-vibe', 'Mistral Vibe', 'vibe'),
  entry('qwen-code', 'Qwen Code', 'qwen-code'),
  entry('crush', 'Charm', 'crush'),
  entry('antigravity', 'Antigravity', 'agy'),
  entry('cursor', 'Cursor', 'cursor-agent')
]

describe('agent picker search', () => {
  it('keeps catalog order for an empty query', () => {
    expect(searchAgentPickerEntries(agents, '').map((agent) => agent.id)).toEqual(
      agents.map((agent) => agent.id)
    )
  })

  it('prefers label matches over command and id aliases', () => {
    expect(
      searchAgentPickerEntries(agents, 'cod')
        .map((agent) => agent.id)
        .slice(0, 3)
    ).toEqual(['codex', 'opencode', 'qwen-code'])
  })

  it('matches multi-word agents by initials and ordered shorthand', () => {
    expect(searchAgentPickerEntries(agents, 'gc')[0]?.id).toBe('copilot')
    expect(searchAgentPickerEntries(agents, 'mv')[0]?.id).toBe('mistral-vibe')
    expect(searchAgentPickerEntries(agents, 'qc')[0]?.id).toBe('qwen-code')
  })

  it('matches command aliases that do not appear in the display label', () => {
    expect(searchAgentPickerEntries(agents, 'agy')[0]?.id).toBe('antigravity')
    expect(searchAgentPickerEntries(agents, 'cursor-agent')[0]?.id).toBe('cursor')
  })

  it('resolves every catalog command alias to its agent first', () => {
    for (const agent of AGENT_CATALOG) {
      expect(searchAgentPickerEntries(AGENT_CATALOG, agent.cmd)[0]?.id).toBe(agent.id)
    }
  })

  it('returns no entries for unrelated text', () => {
    expect(searchAgentPickerEntries(agents, 'not-an-agent')).toEqual([])
  })

  it('matches the blank terminal option by terminal, shell, and shorthand queries', () => {
    expect(agentPickerBlankTerminalMatches('term')).toBe(true)
    expect(agentPickerBlankTerminalMatches('shell')).toBe(true)
    expect(agentPickerBlankTerminalMatches('bt')).toBe(true)
    expect(agentPickerBlankTerminalMatches('agent')).toBe(false)
  })

  it('highlights the current value until a search should choose the first visible result', () => {
    const filteredAgents = searchAgentPickerEntries(agents, 'gc')

    expect(
      getAgentPickerCommandValue({
        blankValue: '__none__',
        blankMatchesQuery: false,
        currentValue: 'claude',
        filteredAgents: agents,
        rawQuery: ''
      })
    ).toBe('claude')
    expect(
      getAgentPickerCommandValue({
        blankValue: '__none__',
        blankMatchesQuery: false,
        currentValue: 'claude',
        filteredAgents,
        rawQuery: 'gc'
      })
    ).toBe('copilot')
    expect(
      getAgentPickerCommandValue({
        blankValue: '__none__',
        blankMatchesQuery: true,
        currentValue: 'claude',
        filteredAgents: [],
        rawQuery: 'bt'
      })
    ).toBe('__none__')
  })
})

function entry(id: AgentCatalogEntry['id'], label: string, cmd: string): AgentCatalogEntry {
  return {
    id,
    label,
    cmd,
    homepageUrl: 'https://example.com'
  }
}
