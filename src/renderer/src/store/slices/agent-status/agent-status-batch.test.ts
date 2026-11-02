import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status-freshness'
import type { AppState } from '../../types'
import './agent-status'
import { resetAgentPaneAuthorityAliasesForTests } from '../agent-pane-authority'
import { MAX_LIVE_AGENT_STATUSES } from './agent-status-capacity-eviction'
import type {
  AgentStatusBatchUpdate,
  AgentStatusChange,
  RetainedAgentEntry
} from './agent-status-contract'
import type { GeneratedTabTitleUpdate } from '../terminal-tab-title-batch'
import { createTestStore } from '../store-test-helpers'
import { makeTab, makeUnifiedTab } from '../store-session-test-harness'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { layoutApplyTestDouble } from '@/runtime/layout-apply-test-double'

const BASE_TIME = 2_000_000
const FIRST_PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const SECOND_PANE = 'tab-1:22222222-2222-4222-8222-222222222222'
const PROVIDER_SESSION = {
  key: 'session_id' as const,
  id: 'pi-session-1',
  transcriptPath: '/tmp/pi-session-1.jsonl'
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

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

function makeUpdates(): AgentStatusBatchUpdate[] {
  return [
    {
      paneKey: FIRST_PANE,
      payload: { state: 'working', prompt: 'first turn', agentType: 'pi' },
      terminalTitle: 'Pi',
      timing: { updatedAt: BASE_TIME, stateStartedAt: BASE_TIME },
      routing: { tabId: 'tab-1', worktreeId: 'wt-1', terminalHandle: 'pty-1' },
      metadata: { providerSession: PROVIDER_SESSION }
    },
    {
      paneKey: FIRST_PANE,
      payload: {
        state: 'waiting',
        prompt: 'first turn',
        agentType: 'pi',
        toolName: 'AskUserQuestion'
      },
      timing: { updatedAt: BASE_TIME + 1, stateStartedAt: BASE_TIME + 1 }
    },
    {
      paneKey: FIRST_PANE,
      payload: {
        state: 'done',
        prompt: 'first turn',
        agentType: 'pi',
        lastAssistantMessage: 'Finished.'
      },
      timing: { updatedAt: BASE_TIME + 2, stateStartedAt: BASE_TIME + 2 }
    },
    {
      paneKey: FIRST_PANE,
      payload: { state: 'working', prompt: 'second turn', agentType: 'pi' },
      timing: { updatedAt: BASE_TIME + 3, stateStartedAt: BASE_TIME + 3 }
    },
    {
      paneKey: FIRST_PANE,
      payload: { state: 'done', prompt: 'late first turn', agentType: 'pi' },
      timing: { updatedAt: BASE_TIME + 2, stateStartedAt: BASE_TIME + 2 }
    },
    {
      kind: 'providerSession',
      paneKey: SECOND_PANE,
      agent: 'pi',
      providerSession: PROVIDER_SESSION,
      timing: { updatedAt: BASE_TIME + 4 },
      routing: { tabId: 'tab-1', worktreeId: 'wt-1' }
    },
    {
      paneKey: SECOND_PANE,
      payload: { state: 'working', prompt: 'provider turn', agentType: 'pi' },
      timing: { updatedAt: BASE_TIME + 5, stateStartedAt: BASE_TIME + 5 },
      routing: { tabId: 'tab-1', worktreeId: 'wt-1' },
      metadata: { providerSession: PROVIDER_SESSION }
    }
  ]
}

function selectBatchState(state: AppState) {
  return {
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    agentLaunchConfigByPaneKey: state.agentLaunchConfigByPaneKey,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
    retentionSuppressedPaneKeys: state.retentionSuppressedPaneKeys,
    agentStatusEpoch: state.agentStatusEpoch,
    sortEpoch: state.sortEpoch
  }
}

describe('setAgentStatuses', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('matches sequential updates across repeated panes and provider-session records', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME + 10)
    const sequentialStore = seedBatchStore()
    const batchStore = seedBatchStore()
    const sequentialTitleGeneration = vi.fn()
    const batchTitleGeneration = vi.fn()
    const batchTitleGenerationBulk = vi.fn((updates: readonly GeneratedTabTitleUpdate[]) => {
      for (const update of updates) {
        if (update.options) {
          batchTitleGeneration(update.paneKey, update.prompt, update.options)
        } else {
          batchTitleGeneration(update.paneKey, update.prompt)
        }
      }
    })
    sequentialStore.setState({
      setGeneratedTabTitleFromAgentPrompt: sequentialTitleGeneration
    } as Partial<AppState>)
    batchStore.setState({
      setGeneratedTabTitlesFromAgentPrompts: batchTitleGenerationBulk
    } as Partial<AppState>)
    const updates = makeUpdates()

    for (const update of updates) {
      if (update.kind === 'providerSession') {
        sequentialStore
          .getState()
          .recordAgentProviderSession(
            update.paneKey,
            update.agent,
            update.providerSession,
            update.timing,
            update.routing,
            update.metadata
          )
      } else if (update.kind === 'programStatus') {
        sequentialStore.getState().setAgentProgramStatus(update.paneKey, update.programStatus)
      } else {
        sequentialStore
          .getState()
          .setAgentStatus(
            update.paneKey,
            update.payload,
            update.terminalTitle,
            update.timing,
            update.routing,
            update.metadata
          )
      }
    }
    const outcomes = batchStore.getState().setAgentStatuses(updates)

    expect(outcomes).toEqual([true, true, true, true, false, true, true])
    expect(selectBatchState(batchStore.getState())).toEqual(
      selectBatchState(sequentialStore.getState())
    )
    expect(
      batchStore.getState().agentStatusByPaneKey[FIRST_PANE].stateHistory.at(-1)
    ).toMatchObject({ state: 'done' })
    // The swallowed `done`'s output survives on the entry, not on the history row.
    expect(
      batchStore.getState().agentStatusByPaneKey[FIRST_PANE].lastCompletedAssistantMessage
    ).toBe('Finished.')
    expect(batchTitleGeneration.mock.calls).toEqual(sequentialTitleGeneration.mock.calls)
    expect(batchTitleGeneration).toHaveBeenCalledTimes(5)
    expect(batchTitleGenerationBulk).toHaveBeenCalledOnce()
    await flushMicrotasks()
    expect(batchStore.getState().refreshGitHubForWorktreeIfStale).toHaveBeenCalledTimes(1)
    expect(sequentialStore.getState().refreshGitHubForWorktreeIfStale).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(selectBatchState(batchStore.getState())).toEqual(
      selectBatchState(sequentialStore.getState())
    )
  })

  it('publishes once and reports skipped ordered updates', () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME + 10)
    const store = seedBatchStore()
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    const outcomes = store.getState().setAgentStatuses(makeUpdates())

    expect(outcomes).toEqual([true, true, true, true, false, true, true])
    expect(publications).toBe(1)
    expect(store.getState().setAgentStatuses([])).toEqual([])
    expect(publications).toBe(1)
    unsubscribe()
  })

  it('coalesces 100 generated tab titles into one post-status publication, or leaves them to main', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME + 10)
    const main = layoutApplyTestDouble()
    vi.stubGlobal('window', { api: { runtime: { call: main.call } } })
    const store = createTestStore()
    const paneCount = 100
    const tabsByWorktree = Object.fromEntries(
      Array.from({ length: paneCount }, (_, index) => {
        const worktreeId = `wt-${index}`
        return [worktreeId, [makeTab({ id: `tab-${index}`, worktreeId })]]
      })
    )
    // Tab-bar entries, so a layout-owner build leaves the titles to main.
    const unifiedTabsByWorktree = Object.fromEntries(
      Array.from({ length: paneCount }, (_, index) => {
        const worktreeId = `wt-${index}`
        return [worktreeId, [makeUnifiedTab({ id: `tab-${index}`, worktreeId, groupId: 'g' })]]
      })
    )
    store.setState({
      settings: { ...store.getState().settings, tabAutoGenerateTitle: true },
      tabsByWorktree
    } as Partial<AppState>)
    store.setState({ unifiedTabsByWorktree })
    const updates: AgentStatusBatchUpdate[] = Array.from({ length: paneCount }, (_, index) => ({
      paneKey: `tab-${index}:11111111-1111-4111-8111-111111111111`,
      payload: {
        state: 'working',
        prompt: `Refactor remote startup module ${index}`,
        agentType: 'pi'
      },
      timing: { updatedAt: BASE_TIME + index, stateStartedAt: BASE_TIME + index },
      routing: { tabId: `tab-${index}`, worktreeId: `wt-${index}` }
    }))
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    const outcomes = store.getState().setAgentStatuses(updates)

    expect(outcomes).toEqual(Array(paneCount).fill(true))
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main derives titles and frames write them once; window batch writes only status and sends no titles.
      for (let turn = 0; turn < 10; turn += 1) {
        await Promise.resolve()
      }
      unsubscribe()
      expect(publications).toBe(1)
      expect(store.getState().tabsByWorktree['wt-99']?.[0]?.generatedTitle).toBeUndefined()
      expect(main.commands).toEqual([])
      return
    }
    expect(store.getState().tabsByWorktree['wt-99']?.[0]?.generatedTitle).toBe(
      'Refactor remote startup module 99'
    )
    unsubscribe()
    expect(publications).toBe(2)
    expect(main.commands).toEqual([])
  })

  it('coalesces batch freshness requests while preserving standalone scheduling', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME + 10)
    const store = seedBatchStore()
    const queueMicrotaskSpy = vi.spyOn(globalThis, 'queueMicrotask')
    const workingUpdate = (updatedAt: number, prompt: string): AgentStatusBatchUpdate => ({
      paneKey: FIRST_PANE,
      payload: { state: 'working', prompt, agentType: 'pi' },
      timing: { updatedAt, stateStartedAt: updatedAt },
      routing: { tabId: 'tab-1', worktreeId: 'wt-1' }
    })

    const outcomes = store
      .getState()
      .setAgentStatuses([
        workingUpdate(BASE_TIME, 'first'),
        workingUpdate(BASE_TIME + 1, 'second'),
        workingUpdate(BASE_TIME + 2, 'third'),
        workingUpdate(BASE_TIME + 1, 'stale')
      ])

    expect(outcomes).toEqual([true, true, true, false])
    expect(queueMicrotaskSpy).toHaveBeenCalledTimes(1)

    queueMicrotaskSpy.mockClear()
    store
      .getState()
      .setAgentStatus(
        FIRST_PANE,
        { state: 'working', prompt: 'standalone', agentType: 'pi' },
        undefined,
        { updatedAt: BASE_TIME + 3, stateStartedAt: BASE_TIME + 3 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )
    store
      .getState()
      .setAgentStatus(
        FIRST_PANE,
        { state: 'working', prompt: 'standalone stale', agentType: 'pi' },
        undefined,
        { updatedAt: BASE_TIME + 2, stateStartedAt: BASE_TIME + 2 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    expect(queueMicrotaskSpy).toHaveBeenCalledTimes(2)
    await flushMicrotasks()
  })

  it('shares freshness across nested folds but isolates synchronous reentrant transactions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME + 10)
    const store = seedBatchStore()
    const queueMicrotaskSpy = vi.spyOn(globalThis, 'queueMicrotask')
    const update = (paneKey: string, updatedAt: number): AgentStatusBatchUpdate => ({
      paneKey,
      payload: { state: 'working', prompt: paneKey, agentType: 'pi' },
      timing: { updatedAt, stateStartedAt: updatedAt },
      routing: { tabId: 'tab-1', worktreeId: 'wt-1' }
    })
    let publications = 0
    const unsubscribeNested = store.subscribe(() => {
      publications += 1
    })

    const nestedOutcomes = store
      .getState()
      .transactAgentStatuses((transaction) => [
        transaction.apply(update(FIRST_PANE, BASE_TIME)),
        store
          .getState()
          .transactAgentStatuses((nestedTransaction) =>
            nestedTransaction.apply(update(SECOND_PANE, BASE_TIME + 1))
          )
      ])

    expect(nestedOutcomes).toEqual([true, true])
    expect(publications).toBe(1)
    expect(queueMicrotaskSpy).toHaveBeenCalledTimes(1)
    unsubscribeNested()

    queueMicrotaskSpy.mockClear()
    let reentered = false
    const unsubscribeReentrant = store.subscribe(() => {
      publications += 1
      if (!reentered) {
        reentered = true
        store.getState().setAgentStatuses([update(SECOND_PANE, BASE_TIME + 3)])
      }
    })

    store.getState().setAgentStatuses([update(FIRST_PANE, BASE_TIME + 2)])

    expect(publications).toBe(3)
    expect(queueMicrotaskSpy).toHaveBeenCalledTimes(2)
    expect(store.getState().agentStatusByPaneKey[FIRST_PANE]?.updatedAt).toBe(BASE_TIME + 2)
    expect(store.getState().agentStatusByPaneKey[SECOND_PANE]?.updatedAt).toBe(BASE_TIME + 3)
    unsubscribeReentrant()
    await flushMicrotasks()
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

  it('clears the completed-turn message when a done carried no assistant output', () => {
    const store = seedBatchStore()
    store.getState().setAgentStatuses([
      {
        paneKey: FIRST_PANE,
        payload: { state: 'working', prompt: 'first turn', agentType: 'pi' },
        timing: { updatedAt: BASE_TIME, stateStartedAt: BASE_TIME }
      },
      {
        paneKey: FIRST_PANE,
        payload: {
          state: 'done',
          prompt: 'first turn',
          agentType: 'pi',
          lastAssistantMessage: 'Finished.'
        },
        timing: { updatedAt: BASE_TIME + 1, stateStartedAt: BASE_TIME + 1 }
      },
      {
        paneKey: FIRST_PANE,
        payload: { state: 'working', prompt: 'second turn', agentType: 'pi' },
        timing: { updatedAt: BASE_TIME + 2, stateStartedAt: BASE_TIME + 2 }
      },
      {
        paneKey: FIRST_PANE,
        payload: { state: 'done', prompt: 'second turn', agentType: 'pi' },
        timing: { updatedAt: BASE_TIME + 3, stateStartedAt: BASE_TIME + 3 }
      },
      {
        paneKey: FIRST_PANE,
        payload: { state: 'working', prompt: 'third turn', agentType: 'pi' },
        timing: { updatedAt: BASE_TIME + 4, stateStartedAt: BASE_TIME + 4 }
      }
    ])

    // The second turn finished silently; leaking turn one's output would misreport the run.
    expect(
      store.getState().agentStatusByPaneKey[FIRST_PANE].lastCompletedAssistantMessage
    ).toBeUndefined()
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
  it('suppresses an equal accepted row rebuilt by remove and re-add in one transaction', () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const store = seedBatchStore()
    write(store, SECOND_PANE)
    const previous = store.getState().agentStatusByPaneKey[SECOND_PANE]
    const observed = vi.fn()
    store.getState().subscribeAgentStatusChanges(observed)
    store.getState().transactAgentStatuses(() => {
      store.getState().removeAgentStatus(SECOND_PANE)
      write(store, SECOND_PANE)
    })
    const current = store.getState().agentStatusByPaneKey[SECOND_PANE]
    expect(current).toEqual(previous)
    expect(current.stateHistory).not.toBe(previous.stateHistory)
    expect(observed).not.toHaveBeenCalled()
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
  it.each([
    'remove',
    'prefix',
    'drop',
    'drop-prefix',
    'worktree',
    'hibernate',
    'retire',
    'provider',
    'program',
    'orchestration',
    'authority',
    'connection',
    'marker'
  ] as const)('reports the known accepted keys for %s', (action) => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    const store = seedBatchStore()
    write(store)
    const previous = store.getState().agentStatusByPaneKey[FIRST_PANE]
    const observed = vi.fn()
    store.getState().subscribeAgentStatusChanges(observed)
    const state = store.getState()
    switch (action) {
      case 'remove':
        state.removeAgentStatus(FIRST_PANE)
        break
      case 'prefix':
        state.removeAgentStatusByTabPrefix('tab-1')
        break
      case 'drop':
        state.dropAgentStatus(FIRST_PANE)
        break
      case 'drop-prefix':
        state.dropAgentStatusByTabPrefix('tab-1')
        break
      case 'worktree':
        state.dropAgentStatusByWorktree('wt-1')
        break
      case 'hibernate':
        state.dropHibernatedAgentStatusPane('wt-1', FIRST_PANE)
        break
      case 'retire':
        state.retireAgentPaneAuthority(FIRST_PANE)
        break
      case 'provider':
        state.recordAgentProviderSession(
          FIRST_PANE,
          'claude',
          { key: 'session_id', id: 'session' },
          { updatedAt: BASE_TIME + 1 },
          { worktreeId: 'wt-1' }
        )
        break
      case 'program':
        state.setAgentProgramStatus(FIRST_PANE, {
          state: 'working',
          progress: 20,
          observedAt: BASE_TIME
        })
        break
      case 'orchestration':
        state.setRuntimeAgentOrchestrationByPaneKey({
          [FIRST_PANE]: { taskId: 'task', dispatchId: 'dispatch' }
        })
        break
      case 'authority':
        state.transferAgentPaneAuthority({ fromPaneKey: FIRST_PANE, toPaneKey: SECOND_PANE })
        break
      case 'connection':
        store.setState({
          agentStatusByPaneKey: { [FIRST_PANE]: { ...previous, connectionId: 'server' } }
        })
        state.clearTransientAgentStatuses('server', BASE_TIME)
        break
      case 'marker':
        write(store, FIRST_PANE, false)
        break
    }
    expect(observed).toHaveBeenCalledOnce()
    const changes: readonly AgentStatusChange[] = observed.mock.calls[0][0]
    expect(changes.map((change) => change.paneKey)).toEqual(
      action === 'authority' ? [FIRST_PANE, SECOND_PANE] : [FIRST_PANE]
    )
    expect(changes[0].previous?.terminalResumeEligible).toBe(false)
    for (const change of changes) {
      expect(change.current).toBe(store.getState().agentStatusByPaneKey[change.paneKey])
    }
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
