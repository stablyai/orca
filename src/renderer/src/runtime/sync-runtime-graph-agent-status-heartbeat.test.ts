import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  buildRuntimeMobileAgentStatusProjection,
  resetRuntimeMobileAgentStatusProjectionCacheForTests
} from './sync-runtime-graph/agent-status-projection'
import { createTestStore } from '../store/slices/store-test-helpers'

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    state: 'working',
    prompt: 'fix "quotes" and 日本 \\ paths',
    updatedAt: 30_000_000,
    stateStartedAt: 29_000_000,
    agentType: 'claude',
    terminalTitle: 'Claude',
    stateHistory: [{ state: 'waiting', prompt: 'a question', startedAt: 28_000_000 }],
    mainAgent: { state: 'working', stateStartedAt: 29_000_000 },
    ...overrides
  }
}

const changedInputs: [string, Partial<AgentStatusEntry>][] = [
  ['entry pane key', { paneKey: 'another:11111111-1111-4111-8111-111111111111' }],
  ['state', { state: 'done' }],
  ['working mode', { workingMode: 'monitoring' }],
  ['prompt', { prompt: 'a new prompt' }],
  ['timestamp bucket', { updatedAt: 30_030_000 }],
  ['state clock', { stateStartedAt: 29_000_001 }],
  ['turn clock', { turnStartedAt: 29_000_001 }],
  ['agent', { agentType: 'codex' }],
  ['terminal title', { terminalTitle: 'a new title' }],
  ['tool name', { toolName: 'shell' }],
  ['tool input', { toolInput: 'ls -la' }],
  ['interactive prompt', { interactivePrompt: '{"question":"ready?"}' }],
  ['assistant message', { lastAssistantMessage: 'a new answer' }],
  ['assistant output kind', { lastAssistantMessageIsToolOutput: true }],
  ['interruption', { interrupted: true }],
  ['main state', { mainAgent: { state: 'done', stateStartedAt: 29_000_000 } }],
  [
    'main verdict',
    { mainAgent: { state: 'working', outcome: 'failure', stateStartedAt: 29_000_000 } }
  ],
  ['main clock', { mainAgent: { state: 'working', stateStartedAt: 29_000_001 } }],
  ['missing main status', { mainAgent: undefined }]
]

const changedHistory: [string, AgentStatusEntry['stateHistory'][number]][] = [
  ['state', { state: 'working', prompt: 'a question', startedAt: 28_000_000 }],
  ['prompt', { state: 'waiting', prompt: 'another question', startedAt: 28_000_000 }],
  ['clock', { state: 'waiting', prompt: 'a question', startedAt: 28_000_001 }],
  [
    'interruption',
    { state: 'waiting', prompt: 'a question', startedAt: 28_000_000, interrupted: true }
  ],
  [
    'main status',
    {
      state: 'waiting',
      prompt: 'a question',
      startedAt: 28_000_000,
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 27_000_000 }
    }
  ]
]

afterEach(() => {
  resetRuntimeMobileAgentStatusProjectionCacheForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('mobile agent-status heartbeat serialization', () => {
  it('skips serialization for every unchanged row in a capped heartbeat batch', () => {
    const before: Record<string, AgentStatusEntry> = {}
    for (let index = 0; index < 500; index++) {
      const paneKey = `tab-${index}:11111111-1111-4111-8111-111111111111`
      before[paneKey] = entry({ paneKey, lastAssistantMessage: 'answer '.repeat(1_000) })
    }
    const first = buildRuntimeMobileAgentStatusProjection(before)
    const after = Object.fromEntries(
      Object.entries(before).map(([paneKey, row]) => [
        paneKey,
        { ...row, updatedAt: row.updatedAt + 1, mainAgent: { ...row.mainAgent! } }
      ])
    )
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(buildRuntimeMobileAgentStatusProjection(after)).toBe(first)
    expect(stringify).not.toHaveBeenCalled()
  })

  it.each(changedInputs)(
    'republishes a changed %s and matches a fresh projection',
    (_label, patch) => {
      const row = entry()
      const first = buildRuntimeMobileAgentStatusProjection({ [row.paneKey]: row })
      const changed = { [row.paneKey]: { ...row, ...patch } }
      const updated = buildRuntimeMobileAgentStatusProjection(changed)
      expect(updated).not.toBe(first)
      resetRuntimeMobileAgentStatusProjectionCacheForTests()
      expect(updated).toBe(buildRuntimeMobileAgentStatusProjection(changed))
    }
  )

  it.each(changedHistory)('republishes a changed history %s', (_label, history) => {
    const row = entry()
    const first = buildRuntimeMobileAgentStatusProjection({ [row.paneKey]: row })
    const changed = { [row.paneKey]: { ...row, stateHistory: [history] } }
    const updated = buildRuntimeMobileAgentStatusProjection(changed)
    expect(updated).not.toBe(first)
    resetRuntimeMobileAgentStatusProjectionCacheForTests()
    expect(updated).toBe(buildRuntimeMobileAgentStatusProjection(changed))
  })

  it('preserves the projection when history is rebuilt with the same content', () => {
    const row = entry()
    const first = buildRuntimeMobileAgentStatusProjection({ [row.paneKey]: row })
    const changed = { [row.paneKey]: { ...row, stateHistory: [...row.stateHistory] } }
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(buildRuntimeMobileAgentStatusProjection(changed)).toBe(first)
    expect(stringify).toHaveBeenCalledTimes(1)
  })

  it('uses the unchanged history and main status produced by real same-state store updates', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const row = entry()
    store.setState({ agentStatusByPaneKey: { [row.paneKey]: row } })
    const first = buildRuntimeMobileAgentStatusProjection(store.getState().agentStatusByPaneKey)
    store.getState().setAgentStatuses([
      {
        paneKey: row.paneKey,
        payload: {
          state: row.state,
          prompt: row.prompt,
          agentType: row.agentType,
          mainAgent: { ...row.mainAgent! }
        },
        timing: { updatedAt: row.updatedAt + 1 }
      }
    ])
    const updated = store.getState().agentStatusByPaneKey
    expect(updated[row.paneKey]).not.toBe(row)
    expect(updated[row.paneKey].stateHistory).toBe(row.stateHistory)
    expect(updated[row.paneKey].mainAgent).toBe(row.mainAgent)
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(buildRuntimeMobileAgentStatusProjection(updated)).toBe(first)
    expect(stringify).not.toHaveBeenCalled()
  })
})
