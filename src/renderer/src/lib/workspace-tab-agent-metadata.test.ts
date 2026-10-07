import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  buildAgentMetadataTabIndex,
  collectAgentMetadataFromIndex,
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

  it('uses the reader clock for mirrored agent evidence and does not refresh replays', () => {
    const collect = (updatedAt: number) =>
      collectAgentMetadataForTerminal({
        terminalTabId: 'tab-1',
        worktreeId: 'wt-1',
        agentStatusByPaneKey: {
          'tab-1:leaf-1': makeEntry({
            updatedAt,
            evidenceObservedAt: 100,
            mirroredEvidenceReceivedAt: 5_000
          })
        },
        retainedAgentsByPaneKey: {},
        sleepingAgentSessionsByPaneKey: {}
      })[0]?.lastActivityAt

    expect(collect(200)).toBe(5_000)
    expect(collect(50_000)).toBe(5_000)
  })

  it('uses authority observation time for locally observed evidence', () => {
    const [metadata] = collectAgentMetadataForTerminal({
      terminalTabId: 'tab-1',
      worktreeId: 'wt-1',
      agentStatusByPaneKey: {
        'tab-1:leaf-1': makeEntry({ updatedAt: 50_000, evidenceObservedAt: 4_000 })
      },
      retainedAgentsByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {}
    })

    expect(metadata?.lastActivityAt).toBe(4_000)
  })
})

describe('host-qualified agent metadata joins', () => {
  it('does not borrow snippets or activity between same-id worktrees', () => {
    const index = buildAgentMetadataTabIndex({
      agentStatusByPaneKey: {
        'shared-tab:local-pane': makeEntry({
          paneKey: 'shared-tab:local-pane',
          tabId: 'shared-tab',
          prompt: 'local atlas prompt',
          updatedAt: 1_000,
          connectionId: null
        }),
        'shared-tab:remote-pane': makeEntry({
          paneKey: 'shared-tab:remote-pane',
          tabId: 'shared-tab',
          prompt: 'remote atlas prompt',
          updatedAt: 2_000,
          connectionId: 'private-target'
        }),
        'shared-tab:unstamped-pane': makeEntry({
          paneKey: 'shared-tab:unstamped-pane',
          tabId: 'shared-tab',
          prompt: 'unknown owner prompt',
          updatedAt: 3_000
        })
      },
      retainedAgentsByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {}
    })
    const ambiguous = new Set(['wt-1'])
    const local = collectAgentMetadataFromIndex(
      index,
      'shared-tab',
      { id: 'wt-1', hostId: 'local' },
      ambiguous
    )
    const remote = collectAgentMetadataFromIndex(
      index,
      'shared-tab',
      {
        id: 'wt-1',
        hostId: 'ssh:private-target',
        runtimeOwnerEnvironmentId: 'paired-host'
      },
      ambiguous
    )

    expect(local.map((entry) => entry.snippetCandidates[0])).toEqual(['local atlas prompt'])
    expect(remote.map((entry) => entry.snippetCandidates[0])).toEqual(['remote atlas prompt'])
    expect(maxAgentActivityAt(local)).toBe(1_000)
    expect(maxAgentActivityAt(remote)).toBe(2_000)
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
