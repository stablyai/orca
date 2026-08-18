import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import type { RetainedAgentEntry } from './agent-status'
import { createTestStore, makeTab } from './store-test-helpers'

describe('agent status retention + prefix sweep', () => {
  // Why: setAgentStatus schedules a real 30-minute freshness setTimeout via
  // queueMicrotask. Use fake timers so the handle does not leak into the
  // test process.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('removeAgentStatusByTabPrefix scopes by the ":" delimiter so tab-1 does not sweep tab-10', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:0', { state: 'working', prompt: 'p' }, 'claude')
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p' }, 'claude')
    store.getState().setAgentStatus('tab-10:0', { state: 'working', prompt: 'p' }, 'claude')

    store.getState().removeAgentStatusByTabPrefix('tab-1')

    const map = store.getState().agentStatusByPaneKey
    expect(map['tab-1:0']).toBeUndefined()
    expect(map['tab-1:1']).toBeUndefined()
    // Why: the ":" delimiter on the prefix guards against false-prefix matches
    // across tab ids that share a leading substring (tab-1 vs tab-10).
    expect(map['tab-10:0']).toBeDefined()
  })

  it('setAgentStatus clears a retained snapshot for the same paneKey', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const oldEntry: AgentStatusEntry = {
      state: 'done',
      prompt: 'old turn',
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      paneKey: 'tab-a:0',
      stateHistory: [],
      agentType: 'claude'
    }
    const siblingEntry: AgentStatusEntry = {
      state: 'done',
      prompt: 'sibling turn',
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      paneKey: 'tab-a:1',
      stateHistory: [],
      agentType: 'claude'
    }
    const retainedA: RetainedAgentEntry = {
      entry: oldEntry,
      worktreeId: 'wt-a',
      tab: makeTab({ id: 'tab-a', worktreeId: 'wt-a', title: 'claude' }),
      agentType: 'claude',
      startedAt: 1_000
    }
    const retainedSibling: RetainedAgentEntry = {
      entry: siblingEntry,
      worktreeId: 'wt-a',
      tab: makeTab({ id: 'tab-a', worktreeId: 'wt-a', title: 'claude' }),
      agentType: 'claude',
      startedAt: 1_000
    }

    store.getState().retainAgents([retainedA, retainedSibling])
    store
      .getState()
      .setAgentStatus(
        'tab-a:0',
        { state: 'done', prompt: 'interrupted turn', agentType: 'claude', interrupted: true },
        'claude',
        { updatedAt: 2_000, stateStartedAt: 2_000 }
      )

    const state = store.getState()
    expect(state.agentStatusByPaneKey['tab-a:0']).toMatchObject({
      state: 'done',
      prompt: 'interrupted turn',
      interrupted: true
    })
    expect(state.retainedAgentsByPaneKey['tab-a:0']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-a:1']).toBe(retainedSibling)
  })

  it('dismissRetainedAgentsByWorktree removes only entries for the given worktreeId', () => {
    const store = createTestStore()
    const now = Date.now()
    const entryA: AgentStatusEntry = {
      state: 'done',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-a:0',
      stateHistory: []
    }
    const entryB: AgentStatusEntry = {
      state: 'done',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-b:0',
      stateHistory: []
    }
    const retainedA: RetainedAgentEntry = {
      entry: entryA,
      worktreeId: 'wt-a',
      tab: makeTab({ id: 'tab-a', worktreeId: 'wt-a', title: 'claude' }),
      agentType: 'claude',
      startedAt: now
    }
    const retainedB: RetainedAgentEntry = {
      entry: entryB,
      worktreeId: 'wt-b',
      tab: makeTab({ id: 'tab-b', worktreeId: 'wt-b', title: 'claude' }),
      agentType: 'claude',
      startedAt: now
    }

    store.getState().retainAgents([retainedA, retainedB])
    store.getState().dismissRetainedAgentsByWorktree('wt-a')

    const retained = store.getState().retainedAgentsByPaneKey
    expect(retained['tab-a:0']).toBeUndefined()
    expect(retained['tab-b:0']).toBeDefined()
    expect(retained['tab-b:0'].worktreeId).toBe('wt-b')
  })

  it('dismissRetainedAgentsByWorktree plants retention suppressors for paneKeys that also have a live entry', () => {
    // Why: regression guard for the "Dismiss all" resurrection bug. If a
    // dismissed paneKey still has a live entry in agentStatusByPaneKey, the
    // retention sync (collectRetainedAgentsOnDisappear) would re-retain the
    // row the next time the live agent disappears — silently undoing the
    // user's bulk dismissal. Mirror dismissRetainedAgent's hasLive-gated
    // suppressor logic so the next live→gone transition is ignored.
    vi.useFakeTimers()
    const store = createTestStore()
    const now = Date.now()
    const entryA: AgentStatusEntry = {
      state: 'done',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-a:0',
      stateHistory: []
    }
    const entryB: AgentStatusEntry = {
      state: 'done',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-a:1',
      stateHistory: []
    }
    const retainedA: RetainedAgentEntry = {
      entry: entryA,
      worktreeId: 'wt-a',
      tab: makeTab({ id: 'tab-a', worktreeId: 'wt-a', title: 'claude' }),
      agentType: 'claude',
      startedAt: now
    }
    const retainedB: RetainedAgentEntry = {
      entry: entryB,
      worktreeId: 'wt-a',
      tab: makeTab({ id: 'tab-a', worktreeId: 'wt-a', title: 'claude' }),
      agentType: 'claude',
      startedAt: now
    }

    // Set up a live entry for retainedA's paneKey only — retainedB is retained-only.
    store
      .getState()
      .setAgentStatus('tab-a:0', { state: 'working', prompt: 'p', agentType: 'claude' })
    store.getState().retainAgents([retainedA, retainedB])
    store.getState().dismissRetainedAgentsByWorktree('wt-a')

    const suppressed = store.getState().retentionSuppressedPaneKeys
    // hasLive → suppressor planted, so the next live→gone will not re-retain.
    expect(suppressed['tab-a:0']).toBe(true)
    // retained-only (no live entry) → no suppressor, to avoid indefinite
    // leaks when no live→gone transition will ever fire for this paneKey.
    expect(suppressed['tab-a:1']).toBeUndefined()
  })

  it('dropAgentStatusByWorktree removes live entries attributed before their tab exists', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const paneKey = 'tab-worker:11111111-1111-4111-8111-111111111111'

    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'worker', agentType: 'codex' },
        undefined,
        undefined,
        {
          tabId: 'tab-worker',
          worktreeId: 'wt-a',
          terminalHandle: 'term-worker'
        }
      )
    store.setState({
      acknowledgedAgentsByPaneKey: { [paneKey]: Date.now() }
    } as Partial<AppState>)

    store.getState().dropAgentStatusByWorktree('wt-a')

    expect(store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().acknowledgedAgentsByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().retentionSuppressedPaneKeys[paneKey]).toBe(true)
  })

  it('pruneRetainedAgents keeps only entries whose worktreeId is in the valid set', () => {
    const store = createTestStore()
    const now = Date.now()
    const entryA: AgentStatusEntry = {
      state: 'done',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-a:0',
      stateHistory: []
    }
    const entryB: AgentStatusEntry = {
      state: 'done',
      prompt: '',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: 'tab-b:0',
      stateHistory: []
    }
    const retainedA: RetainedAgentEntry = {
      entry: entryA,
      worktreeId: 'wt-a',
      tab: makeTab({ id: 'tab-a', worktreeId: 'wt-a', title: 'claude' }),
      agentType: 'claude',
      startedAt: now
    }
    const retainedB: RetainedAgentEntry = {
      entry: entryB,
      worktreeId: 'wt-b',
      tab: makeTab({ id: 'tab-b', worktreeId: 'wt-b', title: 'claude' }),
      agentType: 'claude',
      startedAt: now
    }

    store.getState().retainAgents([retainedA, retainedB])
    store.getState().pruneRetainedAgents(new Set(['wt-a']))

    const retained = store.getState().retainedAgentsByPaneKey
    expect(retained['tab-a:0']).toBeDefined()
    expect(retained['tab-a:0'].worktreeId).toBe('wt-a')
    expect(retained['tab-b:0']).toBeUndefined()
  })
})
