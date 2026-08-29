import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { createTerminalTabAgentTypeSelector } from './terminal-tab-agent-type-index'

function entry(agentType: AgentStatusEntry['agentType'], state = 'working'): AgentStatusEntry {
  return { agentType, state, updatedAt: 0 } as AgentStatusEntry
}

describe('createTerminalTabAgentTypeSelector', () => {
  it('scans one global map only once across all mounted tab selectors', () => {
    const onEntryVisited = vi.fn()
    const select = createTerminalTabAgentTypeSelector({ onEntryVisited })
    const state = {
      'tab-1:leaf-a': entry('claude'),
      'tab-1:leaf-b': entry('codex'),
      'tab-2:leaf-c': entry('grok')
    }

    expect(select(state, 'tab-1')).toEqual({ 'leaf-a': 'claude', 'leaf-b': 'codex' })
    expect(select(state, 'tab-2')).toEqual({ 'leaf-c': 'grok' })
    for (let index = 0; index < 100; index += 1) {
      select(state, `hidden-tab-${index}`)
    }

    expect(onEntryVisited).toHaveBeenCalledTimes(3)
  })

  it('reuses per-tab results across state-only agent transitions', () => {
    const select = createTerminalTabAgentTypeSelector()
    const working = {
      'tab-1:leaf-a': entry('claude', 'working'),
      'tab-2:leaf-b': entry('codex', 'working')
    }
    const firstTab = select(working, 'tab-1')
    const secondTab = select(working, 'tab-2')
    const done = {
      'tab-1:leaf-a': entry('claude', 'done'),
      'tab-2:leaf-b': entry('codex', 'done')
    }

    expect(select(done, 'tab-1')).toBe(firstTab)
    expect(select(done, 'tab-2')).toBe(secondTab)
  })

  it('changes only the tab whose agent identity changes', () => {
    const select = createTerminalTabAgentTypeSelector()
    const before = {
      'tab-1:leaf-a': entry('claude'),
      'tab-2:leaf-b': entry('codex')
    }
    const firstTab = select(before, 'tab-1')
    const secondTab = select(before, 'tab-2')
    const after = {
      ...before,
      'tab-2:leaf-b': entry('grok')
    }

    expect(select(after, 'tab-1')).toBe(firstTab)
    expect(select(after, 'tab-2')).not.toBe(secondTab)
    expect(select(after, 'tab-2')).toEqual({ 'leaf-b': 'grok' })
  })

  it('ignores missing agent types and keys without a tab prefix', () => {
    const select = createTerminalTabAgentTypeSelector()
    const state = {
      malformed: entry('claude'),
      ':leaf-a': entry('codex'),
      'tab-1:leaf-a': entry(undefined)
    }

    expect(select(state, 'tab-1')).toEqual({})
    expect(select(state, 'malformed')).toEqual({})
  })
})
