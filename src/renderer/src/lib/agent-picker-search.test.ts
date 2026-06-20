import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PICKER_QUERY_MAX_BYTES,
  agentPickerBlankTerminalMatches,
  getAgentPickerCommandValue,
  isAgentPickerQueryTooLarge,
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

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('normalizes accepted pasted whitespace without regex replacement', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')

    expect(searchAgentPickerEntries(agents, '  qwen\n\tcode  ')[0]?.id).toBe('qwen-code')

    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('resolves every catalog command alias to its agent first', () => {
    for (const agent of AGENT_CATALOG) {
      expect(searchAgentPickerEntries(AGENT_CATALOG, agent.cmd)[0]?.id).toBe(agent.id)
    }
  })

  it('returns no entries for unrelated text', () => {
    expect(searchAgentPickerEntries(agents, 'not-an-agent')).toEqual([])
  })

  it('rejects oversized pasted queries before scoring agent candidates', () => {
    const oversizedQuery = 'secret-agent-picker'.repeat(AGENT_PICKER_QUERY_MAX_BYTES)
    const throwingAgents = [
      {
        get id(): AgentCatalogEntry['id'] {
          throw new Error('oversized agent picker queries must not scan ids')
        },
        get label(): string {
          throw new Error('oversized agent picker queries must not scan labels')
        },
        get cmd(): string {
          throw new Error('oversized agent picker queries must not scan commands')
        },
        homepageUrl: 'https://example.com'
      }
    ] as AgentCatalogEntry[]

    expect(isAgentPickerQueryTooLarge(oversizedQuery)).toBe(true)
    expect(searchAgentPickerEntries(throwingAgents, oversizedQuery)).toEqual([])
    expect(agentPickerBlankTerminalMatches(oversizedQuery)).toBe(false)
    expect(
      getAgentPickerCommandValue({
        blankValue: '__none__',
        blankMatchesQuery: false,
        currentValue: 'claude',
        filteredAgents: throwingAgents,
        rawQuery: oversizedQuery
      })
    ).toBe('')
  })

  it('rejects oversized whitespace before trimming', () => {
    expect(searchAgentPickerEntries(agents, ' '.repeat(AGENT_PICKER_QUERY_MAX_BYTES + 1))).toEqual(
      []
    )
    expect(agentPickerBlankTerminalMatches(' '.repeat(AGENT_PICKER_QUERY_MAX_BYTES + 1))).toBe(
      false
    )
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
