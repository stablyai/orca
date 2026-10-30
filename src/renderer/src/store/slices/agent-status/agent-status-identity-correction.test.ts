import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../store-test-helpers'

const PANE = 'tab-1:1'

describe('process-backed compatible status identity correction', () => {
  afterEach(() => vi.useRealTimers())

  it('changes only compatible identity/title and preserves the accepted turn and attention', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(PANE, { state: 'done', agentType: 'pi', prompt: 'task' }, 'Pi ready')
    store.getState().setPaneForegroundAgent(PANE, {
      agent: 'omp',
      agentEvidence: 'process-read',
      shellForeground: false
    })
    const before = store.getState()
    const entry = before.agentStatusByPaneKey[PANE]
    const foreground = before.paneForegroundAgentByPaneKey[PANE]
    expect(before.correctAgentStatusIdentity(PANE, entry, foreground)).toBe(true)
    const after = store.getState()
    expect(after.agentStatusByPaneKey[PANE]).toEqual({
      ...entry,
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
    expect(after.agentStatusEpoch).toBe(before.agentStatusEpoch)
    expect(after.sortEpoch).toBe(before.sortEpoch)
    expect(after.unreadAgentCompletionPanes).toBe(before.unreadAgentCompletionPanes)
    expect(after.correctAgentStatusIdentity(PANE, entry, foreground)).toBe(false)
  })

  it('rejects replaced rows, replaced evidence, retired panes and non-process hints', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus(PANE, { state: 'working', agentType: 'pi', prompt: '' })
    store.getState().setPaneForegroundAgent(PANE, {
      agent: 'omp',
      agentEvidence: 'process-read',
      shellForeground: false
    })
    const old = store.getState()
    const entry = old.agentStatusByPaneKey[PANE]
    const foreground = old.paneForegroundAgentByPaneKey[PANE]
    store.setState({ agentStatusByPaneKey: { [PANE]: { ...entry, agentType: 'codex' } } })
    expect(store.getState().correctAgentStatusIdentity(PANE, entry, foreground)).toBe(false)
    const row = store.getState().agentStatusByPaneKey[PANE]
    expect(store.getState().correctAgentStatusIdentity(PANE, row, foreground)).toBe(false)
    store.getState().setPaneForegroundAgent(PANE, {
      agent: 'omp',
      agentEvidence: 'launch-record',
      shellForeground: false
    })
    expect(store.getState().correctAgentStatusIdentity(PANE, row, foreground)).toBe(false)
    store.getState().retireAgentPaneAuthority(PANE)
    expect(store.getState().correctAgentStatusIdentity(PANE, entry, foreground)).toBe(false)
    expect(store.getState().correctAgentStatusIdentity('absent:1', entry, foreground)).toBe(false)
  })
})
