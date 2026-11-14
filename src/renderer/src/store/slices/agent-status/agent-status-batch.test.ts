import * as mobileStatusProjection from '@/runtime/sync-runtime-graph/agent-status-projection'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import '../../../../../shared/agent-status/contracts/agent-status-freshness'
import './agent-status'
import { resetAgentPaneAuthorityAliasesForTests } from './agent-pane-authority'
import { MAX_LIVE_AGENT_STATUSES } from './agent-status-capacity-eviction'
import type { AgentStatusBatchUpdate, AgentStatusChange } from './agent-status-contract'

import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/testing/terminal-tab.test-fixture'

const BASE_TIME = 2_000_000
const FIRST_PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const SECOND_PANE = 'tab-1:22222222-2222-4222-8222-222222222222'

function seedBatchStore() {
  const store = createTestStore()
  const tab = makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: 'pi' })
  store.setState({
    tabsByWorktree: { 'wt-1': [tab] },
    refreshGitHubForWorktreeIfStale: vi.fn().mockResolvedValue(undefined)
  })
  return store
}

describe('setAgentStatuses', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('leaves accepted rows and visible rows unchanged when publication preparation fails', () => {
    const store = seedBatchStore()
    store.getState().setAgentStatus(FIRST_PANE, { state: 'working', prompt: 'Task' })
    const before = store.getState()
    const projection = before.agentStatusByPaneKey.projection
    const rows = projection.list('wt-1')
    const observed = vi.fn()
    const stop = before.agentStatusByPaneKey.subscribe(FIRST_PANE, observed)
    const serializer = vi
      .spyOn(mobileStatusProjection, 'serializeAgentStatusEntry')
      .mockImplementationOnce(() => {
        throw new Error('cannot serialize status')
      })
    try {
      expect(() =>
        store.getState().setAgentStatus(FIRST_PANE, { state: 'done', prompt: 'Finished' })
      ).toThrow('cannot serialize status')
      expect(store.getState()).toBe(before)
      expect(before.agentStatusByPaneKey.get(FIRST_PANE)?.state).toBe('working')
      expect(projection.list('wt-1')).toBe(rows)
      expect(observed).not.toHaveBeenCalled()
    } finally {
      serializer.mockRestore()
      stop()
    }
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
    store.setState({
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries(entries))
    })

    const outcomes = store.getState().transactAgentStatuses((transaction) => {
      const added = transaction.apply({
        paneKey: 'orphan-tab:new-pane',
        payload: { state: 'working', prompt: 'new turn', agentType: 'pi' },
        timing: { updatedAt: BASE_TIME + 1, stateStartedAt: BASE_TIME + 1 }
      })
      expect(transaction.getState().agentStatusByPaneKey.get(firstPane)).toBeUndefined()
      const completed = transaction.apply({
        paneKey: firstPane,
        payload: { state: 'done', prompt: 'different agent', agentType: 'claude' },
        timing: { updatedAt: BASE_TIME + 2, stateStartedAt: BASE_TIME + 2 }
      })
      return [added, completed]
    })

    expect(outcomes).toEqual([true, true])
    expect(store.getState().agentStatusByPaneKey.get(firstPane)).toMatchObject({
      agentType: 'claude',
      state: 'done'
    })
  })

  it('leaves candidate order intact when an above-cap eviction transaction aborts', () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const store = seedBatchStore()
    const rows = Array.from(
      { length: MAX_LIVE_AGENT_STATUSES },
      (_, index): readonly [string, AgentStatusEntry] => {
        const paneKey = `orphan-tab:orphan-${index}`
        return [
          paneKey,
          {
            paneKey,
            state: 'done',
            prompt: 'Old turn',
            updatedAt: 0,
            stateStartedAt: 0,
            stateHistory: [],
            terminalResumeEligible: false
          }
        ]
      }
    )
    store.setState({ agentStatusByPaneKey: acceptedAgentStatuses(rows) })
    const before = store.getState().agentStatusByPaneKey
    const captured = before.capture()
    expect(() =>
      store.getState().transactAgentStatuses((transaction) => {
        transaction.apply({
          paneKey: FIRST_PANE,
          payload: { state: 'working', prompt: 'New turn' },
          timing: { updatedAt: BASE_TIME }
        })
        expect(transaction.getState().agentStatusByPaneKey.has('orphan-tab:orphan-0')).toBe(false)
        throw new Error('abort eviction')
      })
    ).toThrow('abort eviction')
    expect(store.getState().agentStatusByPaneKey).toBe(before)
    expect(before.size).toBe(500)
    expect(captured.get('orphan-tab:orphan-0')?.prompt).toBe('Old turn')
    store.getState().setAgentStatus(FIRST_PANE, { state: 'working', prompt: 'New turn' })
    expect(store.getState().agentStatusByPaneKey.has('orphan-tab:orphan-0')).toBe(false)
    expect(store.getState().agentStatusByPaneKey.has('orphan-tab:orphan-1')).toBe(true)
    expect(captured.has('orphan-tab:orphan-0')).toBe(true)
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
      store.setState({ worktreesByRepo: { 'repo-late': [] } })
      return applied
    })

    expect(outcome).toBe(true)
    expect(store.getState().worktreesByRepo).toEqual({ 'repo-late': [] })
    expect(store.getState().agentStatusByPaneKey.get(FIRST_PANE)).toMatchObject({
      state: 'working'
    })
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

    const entry = store.getState().agentStatusByPaneKey.get(FIRST_PANE)!
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
    expect(() =>
      store.getState().transactAgentStatuses(() => {
        store.getState().removeAgentStatus(FIRST_PANE)
        throw new Error('abort')
      })
    ).toThrow('abort')

    expect(() =>
      store.getState().updateAgentStatusState((_state, keys) => {
        keys.add(FIRST_PANE)
        return {
          agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
          get editorDrafts(): Record<string, string> {
            throw new Error('precommit middleware')
          }
        }
      })
    ).toThrow('precommit middleware')

    expect(observed).not.toHaveBeenCalled()
    store.getState().removeAgentStatus(FIRST_PANE)
    expect(observed).toHaveBeenCalledOnce()
  })
  it('isolates stores, disposes listeners, orders reentry and contains observer failures', () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const store = seedBatchStore()
    const other = seedBatchStore()
    vi.spyOn(console, 'error').mockImplementation(() => {})
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

    stopBroken()
  })
  it('finishes an accepted transaction when an ordinary store observer throws', () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const store = seedBatchStore()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let reachedThrowingObserver = false
    const stopBroken = store.subscribe(() => {
      reachedThrowingObserver = true
      throw new Error('ordinary observer')
    })
    let observedPrompt: string | undefined
    const stopLater = store.subscribe((state) => {
      observedPrompt = state.agentStatusByPaneKey.get(FIRST_PANE)?.prompt
    })
    let committedPrompt: string | undefined
    try {
      expect(() =>
        store.getState().transactAgentStatuses((transaction) => {
          transaction.apply({
            paneKey: FIRST_PANE,
            payload: { state: 'working', agentType: 'claude', prompt: 'Accepted task' },
            timing: { updatedAt: BASE_TIME, stateStartedAt: BASE_TIME }
          })
          transaction.afterCommit(() => {
            committedPrompt = store.getState().agentStatusByPaneKey.get(FIRST_PANE)?.prompt
          })
        })
      ).not.toThrow()
      expect(reachedThrowingObserver).toBe(true)
      expect(observedPrompt).toBe('Accepted task')
      expect(committedPrompt).toBe('Accepted task')
    } finally {
      stopBroken()
      stopLater()
    }
  })
  it('announces every eviction when later folds share the private batch draft', () => {
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
    store.setState({ agentStatusByPaneKey: acceptedAgentStatuses(Object.entries(rows)) })
    const observed = vi.fn()
    store.getState().subscribeAgentStatusChanges(observed)
    store.getState().transactAgentStatuses(() => {
      write(store)
      write(store, SECOND_PANE)
    })
    expect(observed).toHaveBeenCalledOnce()
    const changes: readonly AgentStatusChange[] = observed.mock.calls[0][0]
    expect(changes.map((change) => change.paneKey)).toEqual([
      FIRST_PANE,
      'orphan-0',
      SECOND_PANE,
      'orphan-1'
    ])
    expect(changes.filter((change) => !change.current)).toEqual([
      { paneKey: 'orphan-0', previous: rows['orphan-0'], current: undefined },
      { paneKey: 'orphan-1', previous: rows['orphan-1'], current: undefined }
    ])
  })
})
