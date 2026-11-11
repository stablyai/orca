import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import '../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AppState } from '../../types'
import './agent-status'
import { resetAgentPaneAuthorityAliasesForTests } from './agent-pane-authority'
import { MAX_LIVE_AGENT_STATUSES } from './agent-status-capacity-eviction'
import type {
  AgentStatusBatchUpdate,
  AgentStatusChange,
  RetainedAgentEntry
} from './agent-status-contract'

import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/terminal-tab.test-fixture'

const BASE_TIME = 2_000_000
const FIRST_PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const SECOND_PANE = 'tab-1:22222222-2222-4222-8222-222222222222'

function seedBatchStore() {
  const store = createTestStore()
  const tab = makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: 'pi' })
  const retainedEntry: AgentStatusEntry = {
    paneKey: FIRST_PANE,
    state: 'done',
    prompt: 'old turn',
    agentType: 'pi',
    updatedAt: BASE_TIME - 100,
    stateStartedAt: BASE_TIME - 200,
    stateHistory: []
  }
  const retained: RetainedAgentEntry = {
    entry: retainedEntry,
    worktreeId: 'wt-1',
    tab,
    agentType: 'pi',
    startedAt: BASE_TIME - 200
  }
  store.setState({
    tabsByWorktree: { 'wt-1': [tab] },
    retainedAgentsByPaneKey: { [FIRST_PANE]: retained },
    retentionSuppressedPaneKeys: { [FIRST_PANE]: true },
    refreshGitHubForWorktreeIfStale: vi.fn().mockResolvedValue(undefined)
  } as Partial<AppState>)
  return store
}

describe('setAgentStatuses', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('exposes cap evictions to later updates in the same transaction', () => {
    const store = seedBatchStore()
    const firstPane = 'orphan-tab:orphan-0'
    const entries = Object.fromEntries(
      Array.from({ length: MAX_LIVE_AGENT_STATUSES }, (_, index) => {
        const paneKey = `orphan-tab:orphan-${index}`
        return [
          paneKey,
          {
            paneKey,
            state: 'working',
            prompt: 'old turn',
            agentType: 'pi',
            updatedAt: BASE_TIME,
            stateStartedAt: BASE_TIME,
            stateHistory: []
          } satisfies AgentStatusEntry
        ]
      })
    )
    store.setState({ agentStatusByPaneKey: entries } as Partial<AppState>)
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    const outcomes = store.getState().transactAgentStatuses((transaction) => {
      const added = transaction.apply({
        paneKey: 'orphan-tab:new-pane',
        payload: { state: 'working', prompt: 'new turn', agentType: 'pi' },
        timing: { updatedAt: BASE_TIME + 1, stateStartedAt: BASE_TIME + 1 }
      })
      expect(transaction.getState().agentStatusByPaneKey[firstPane]).toBeUndefined()
      const completed = transaction.apply({
        paneKey: firstPane,
        payload: { state: 'done', prompt: 'different agent', agentType: 'claude' },
        timing: { updatedAt: BASE_TIME + 2, stateStartedAt: BASE_TIME + 2 }
      })
      return [added, completed]
    })

    expect(outcomes).toEqual([true, true])
    expect(store.getState().agentStatusByPaneKey[firstPane]).toMatchObject({
      agentType: 'claude',
      state: 'done'
    })
    expect(publications).toBe(1)
    unsubscribe()
  })

  it('preserves a store write that bypassed the transaction instead of reverting it', () => {
    const store = seedBatchStore()

    const outcome = store.getState().transactAgentStatuses((transaction) => {
      const applied = transaction.apply({
        paneKey: FIRST_PANE,
        payload: { state: 'working', prompt: 'first turn', agentType: 'pi' },
        timing: { updatedAt: BASE_TIME, stateStartedAt: BASE_TIME }
      })
      // Nested slice actions write real store; replacing it with the folded snapshot would revert those writes.
      store.setState({ worktreesByRepo: { 'repo-late': [] } } as Partial<AppState>)
      return applied
    })

    expect(outcome).toBe(true)
    expect(store.getState().worktreesByRepo).toEqual({ 'repo-late': [] })
    expect(store.getState().agentStatusByPaneKey[FIRST_PANE]).toMatchObject({ state: 'working' })
  })

  it('keeps one completed-turn message per entry instead of one per history row', () => {
    const store = seedBatchStore()
    const turns: AgentStatusBatchUpdate[] = []
    for (let turn = 0; turn < 5; turn += 1) {
      turns.push({
        paneKey: FIRST_PANE,
        payload: { state: 'working', prompt: `turn ${turn}`, agentType: 'pi' },
        timing: { updatedAt: BASE_TIME + turn * 2, stateStartedAt: BASE_TIME + turn * 2 }
      })
      turns.push({
        paneKey: FIRST_PANE,
        payload: {
          state: 'done',
          prompt: `turn ${turn}`,
          agentType: 'pi',
          lastAssistantMessage: `output ${turn}`
        },
        timing: { updatedAt: BASE_TIME + turn * 2 + 1, stateStartedAt: BASE_TIME + turn * 2 + 1 }
      })
    }
    store.getState().setAgentStatuses(turns)

    const entry = store.getState().agentStatusByPaneKey[FIRST_PANE]
    expect(entry.stateHistory.length).toBeGreaterThan(1)
    expect(entry.stateHistory.some((row) => 'lastAssistantMessage' in row)).toBe(false)
    // Only the newest done that rolled into history is retained, so memory is O(1) per pane.
    expect(entry.lastCompletedAssistantMessage).toBe('output 3')
    expect(entry.lastAssistantMessage).toBe('output 4')
  })
})

describe('committed agent status changes', () => {
  beforeEach(() => resetAgentPaneAuthorityAliasesForTests())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetAgentPaneAuthorityAliasesForTests()
  })
  const write = (store: ReturnType<typeof seedBatchStore>, paneKey = FIRST_PANE, native = true) => {
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', agentType: 'claude', prompt: 'fixed' },
        undefined,
        { updatedAt: BASE_TIME, stateStartedAt: BASE_TIME },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        native ? { terminalResumeEligible: false } : undefined
      )
  }
  it('emits first-before/final-after once after the final transaction is readable', () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const store = seedBatchStore()
    write(store)
    const previous = store.getState().agentStatusByPaneKey[FIRST_PANE]
    const observed = vi.fn((changes: readonly AgentStatusChange[]) => {
      for (const change of changes) {
        expect(store.getState().agentStatusByPaneKey[change.paneKey]).toBe(change.current)
      }
    })
    store.getState().subscribeAgentStatusChanges(observed)
    store.getState().transactAgentStatuses((transaction) => {
      transaction.apply({
        paneKey: FIRST_PANE,
        payload: { state: 'done', prompt: 'fixed', interrupted: true },
        timing: { updatedAt: BASE_TIME + 1 }
      })
      store.getState().transactAgentStatuses((nested) =>
        nested.apply({
          paneKey: FIRST_PANE,
          payload: {
            state: 'done',
            prompt: 'fixed',
            mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: BASE_TIME }
          },
          timing: { updatedAt: BASE_TIME + 2 }
        })
      )
      write(store, SECOND_PANE)
      store.getState().removeAgentStatus(SECOND_PANE)
      expect(observed).not.toHaveBeenCalled()
    })
    expect(observed).toHaveBeenCalledExactlyOnceWith([
      { paneKey: FIRST_PANE, previous, current: store.getState().agentStatusByPaneKey[FIRST_PANE] }
    ])
  })
  it('suppresses rejected, missing, equal, net-equal and failed transaction mutations', () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const store = seedBatchStore()
    write(store)
    const observed = vi.fn()
    store.getState().subscribeAgentStatusChanges(observed)
    store.getState().setAgentStatus(FIRST_PANE, { state: 'done', prompt: 'fixed' }, undefined, {
      updatedAt: BASE_TIME - 1
    })
    store.getState().removeAgentStatus('missing')
    store.getState().setAgentProgramStatus(FIRST_PANE, null)
    store.getState().transactAgentStatuses(() => {
      store.getState().setAgentProgramStatus(FIRST_PANE, {
        state: 'working',
        progress: 42,
        observedAt: BASE_TIME
      })
      store.getState().setAgentProgramStatus(FIRST_PANE, null)
    })
    const before = store.getState().agentStatusByPaneKey
    expect(() =>
      store.getState().transactAgentStatuses(() => {
        store.getState().removeAgentStatus(FIRST_PANE)
        throw new Error('abort')
      })
    ).toThrow('abort')
    expect(store.getState().agentStatusByPaneKey).toBe(before)
    expect(() =>
      store.getState().updateAgentStatusState((_state, keys) => {
        keys.add(FIRST_PANE)
        return {
          agentStatusByPaneKey: {},
          get editorDrafts(): Record<string, string> {
            throw new Error('precommit middleware')
          }
        }
      })
    ).toThrow('precommit middleware')
    expect(store.getState().agentStatusByPaneKey).toBe(before)
    expect(observed).not.toHaveBeenCalled()
    store.getState().removeAgentStatus(FIRST_PANE)
    expect(observed).toHaveBeenCalledOnce()
  })
  it('isolates stores, disposes listeners, orders reentry and contains observer failures', () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const store = seedBatchStore()
    const other = seedBatchStore()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const isolated = vi.fn()
    other.getState().subscribeAgentStatusChanges(isolated)
    const order: string[] = []
    let stopSecond = () => {}
    store.getState().subscribeAgentStatusChanges((changes) => {
      order.push(changes[0].paneKey)
      if (changes[0].paneKey === FIRST_PANE) {
        stopSecond()
        write(store, SECOND_PANE)
      }
    })
    const second = vi.fn()
    stopSecond = store.getState().subscribeAgentStatusChanges(second)
    const stopBroken = store.getState().subscribeAgentStatusChanges(() => {
      throw new Error('observer')
    })
    expect(() => write(store)).not.toThrow()
    expect(order).toEqual([FIRST_PANE, SECOND_PANE])
    expect(second).not.toHaveBeenCalled()
    expect(isolated).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(2)
    stopBroken()
  })
  it('includes evicted rows alongside the accepted replacement', () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const store = seedBatchStore()
    const rows: Record<string, AgentStatusEntry> = {}
    for (let i = 0; i < MAX_LIVE_AGENT_STATUSES; i++) {
      rows[`orphan-${i}`] = {
        paneKey: `orphan-${i}`,
        state: 'done',
        stateHistory: [],
        prompt: '',
        updatedAt: 0,
        stateStartedAt: 0,
        terminalResumeEligible: false
      }
    }
    store.setState({ agentStatusByPaneKey: rows })
    const observed = vi.fn()
    store.getState().subscribeAgentStatusChanges(observed)
    write(store)
    expect(observed).toHaveBeenCalledOnce()
    const changes: readonly AgentStatusChange[] = observed.mock.calls[0][0]
    expect(changes.map((change) => change.paneKey)).toEqual([FIRST_PANE, 'orphan-0'])
    expect(changes[1]).toEqual({
      paneKey: 'orphan-0',
      previous: rows['orphan-0'],
      current: undefined
    })
  })
})
