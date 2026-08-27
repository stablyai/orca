import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  collectAgentMetadataForTerminal,
  maxAgentActivityAt,
  type AgentMetadata
} from './workspace-tab-agent-metadata'

function makeEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'You are working inside Orca, a multi-agent IDE.',
    updatedAt: 1000,
    stateStartedAt: 900,
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    stateHistory: [],
    ...overrides
  }
}

describe('collectAgentMetadataForTerminal', () => {
  it('indexes orchestration task display metadata for tab search snippets', () => {
    const [metadata] = collectAgentMetadataForTerminal({
      terminalTabId: 'tab-1',
      worktreeId: 'wt-1',
      agentStatusByPaneKey: {
        'tab-1:leaf-1': makeEntry({
          orchestration: {
            taskId: 'task-1',
            dispatchId: 'ctx-1',
            taskTitle: 'Checkout race',
            displayName: 'Fix checkout race'
          }
        })
      },
      retainedAgentsByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {}
    })

    expect(metadata?.textParts).toContain('Fix checkout race')
    expect(metadata?.textParts).toContain('Checkout race')
    expect(metadata?.snippetCandidates).toContain('Fix checkout race')
    expect(metadata?.snippetCandidates).toContain('Checkout race')
  })

  it('carries the live entry updatedAt through as lastActivityAt', () => {
    const [metadata] = collectAgentMetadataForTerminal({
      terminalTabId: 'tab-1',
      worktreeId: 'wt-1',
      agentStatusByPaneKey: { 'tab-1:leaf-1': makeEntry({ updatedAt: 5000 }) },
      retainedAgentsByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {}
    })

    expect(metadata?.lastActivityAt).toBe(5000)
  })
})

function makeMetadata(overrides: Partial<AgentMetadata> = {}): AgentMetadata {
  return {
    paneKey: 'pane-1',
    textParts: [],
    snippetCandidates: [],
    lastActivityAt: 0,
    ...overrides
  }
}

describe('maxAgentActivityAt', () => {
  it('returns null when there is no metadata', () => {
    expect(maxAgentActivityAt([])).toBeNull()
  })

  it('returns the highest lastActivityAt across panes', () => {
    const metadata = [
      makeMetadata({ paneKey: 'pane-1', lastActivityAt: 1000 }),
      makeMetadata({ paneKey: 'pane-2', lastActivityAt: 3000 }),
      makeMetadata({ paneKey: 'pane-3', lastActivityAt: 2000 })
    ]

    expect(maxAgentActivityAt(metadata)).toBe(3000)
  })

  it('ignores non-positive lastActivityAt values', () => {
    expect(maxAgentActivityAt([makeMetadata({ lastActivityAt: 0 })])).toBeNull()
  })
})
