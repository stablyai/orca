import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PICKER_QUERY_MAX_BYTES,
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('agent picker search', () => {
  it('does not offer unavailable OMP through a search alias', () => {
    const available = AGENT_CATALOG.filter((agent) => agent.id !== 'omp')
    expect(searchAgentPickerEntries(available, 'oh-my-pi')).toEqual([])
  })

  it('keeps a stable default for a shared binary while explicit CN remains selectable', () => {
    const shared = [
      entry('qoder', 'Qoder CLI', 'qodercli'),
      entry('qoder-cn', 'Qoder CLI China', 'qodercli')
    ]
    expect(searchAgentPickerEntries(shared, 'qodercli').map((agent) => agent.id)).toEqual([
      'qoder',
      'qoder-cn'
    ])
    expect(searchAgentPickerEntries(shared, 'qoder-cn')[0]?.id).toBe('qoder-cn')
    expect(searchAgentPickerEntries(shared, 'Qoder CLI China')[0]?.id).toBe('qoder-cn')
    expect(
      searchAgentPickerEntries(
        shared.filter((agent) => agent.id !== 'qoder'),
        'qodercli'
      )[0]?.id
    ).toBe('qoder-cn')
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
})

function entry(id: AgentCatalogEntry['id'], label: string, cmd: string): AgentCatalogEntry {
  return {
    id,
    label,
    cmd,
    homepageUrl: 'https://example.com'
  }
}
