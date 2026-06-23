/* eslint-disable max-lines -- Why: this file is the umbrella suite for the agent-status slice (freshness, tool/assistant fields, stateStartedAt, retention + prefix sweep). Splitting by sub-area would scatter shared helpers (createTestStore, fake timers); narrower edge-cases live in sibling agent-status-*.test.ts files already. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import type { RetainedAgentEntry } from './agent-status'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'

// Why: queueMicrotask is used by the agent-status slice to schedule the
// freshness timer after state updates. In tests we need to flush microtasks
// before advancing fake timers so the setTimeout gets registered.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

function stubGitHubPRRefreshApi() {
  const enqueuePRRefresh = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      gh: { enqueuePRRefresh }
    }
  })
  return enqueuePRRefresh
}

function seedAgentPRRefreshFixture(
  store: ReturnType<typeof createTestStore>,
  worktreeCardProperties: AppState['worktreeCardProperties']
): void {
  store.setState({
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#999999',
        addedAt: 1,
        kind: 'git'
      }
    ],
    groupBy: 'repo',
    rightSidebarOpen: false,
    worktreeCardProperties,
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({
          id: 'wt-1',
          repoId: 'repo-1',
          path: '/repo/worktrees/pr-from-agent',
          branch: 'feature/pr-from-agent'
        })
      ]
    },
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
    }
  } as Partial<AppState>)
}

describe('agent status freshness expiry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances agentStatusEpoch when a fresh entry crosses the stale threshold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'Fix tests', agentType: 'codex' })

    // setAgentStatus bumps epoch once synchronously
    expect(store.getState().agentStatusEpoch).toBe(1)

    // Flush the queueMicrotask that schedules the freshness timer
    await flushMicrotasks()

    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

    // Timer bump adds another increment
    expect(store.getState().agentStatusEpoch).toBe(2)
  })

  it('cancels the scheduled freshness tick when the entry is removed first', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'Fix tests', agentType: 'codex' })
    // set bumps to 1, remove bumps to 2
    store.getState().removeAgentStatus('tab-1:1')
    expect(store.getState().agentStatusEpoch).toBe(2)

    // Flush microtask and advance past stale threshold
    await flushMicrotasks()
    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

    // No additional bump since the entry was removed before the timer fires
    expect(store.getState().agentStatusEpoch).toBe(2)
  })
})

describe('agent status routing attribution', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores worktree and tab attribution from accepted hook events', () => {
    vi.useFakeTimers()
    const store = createTestStore()

    store
      .getState()
      .setAgentStatus(
        'tab-child:11111111-1111-4111-8111-111111111111',
        { state: 'working', prompt: 'child agent', agentType: 'codex' },
        undefined,
        undefined,
        { tabId: 'tab-child', worktreeId: 'wt-1', terminalHandle: 'term-child' }
      )

    expect(
      store.getState().agentStatusByPaneKey['tab-child:11111111-1111-4111-8111-111111111111']
    ).toMatchObject({
      tabId: 'tab-child',
      worktreeId: 'wt-1',
      terminalHandle: 'term-child'
    })
  })
})

describe('agent status runtime orchestration metadata', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fills runtime orchestration metadata into existing live entries', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'
    const parentPaneKey = 'tab-parent:22222222-2222-4222-8222-222222222222'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex'
    })
    const epochBeforeRuntime = store.getState().agentStatusEpoch
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        taskTitle: 'Checkout race',
        displayName: 'Fix checkout race',
        parentPaneKey
      }
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toMatchObject({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      taskTitle: 'Checkout race',
      displayName: 'Fix checkout race',
      parentPaneKey
    })
    expect(store.getState().agentStatusEpoch).toBe(epochBeforeRuntime + 1)
  })

  it('replaces stale live orchestration metadata when runtime dispatch identity changes', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'
    const staleParentPaneKey = 'tab-parent:22222222-2222-4222-8222-222222222222'
    const currentParentPaneKey = 'tab-parent:33333333-3333-4333-8333-333333333333'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentPaneKey: staleParentPaneKey,
        parentTerminalHandle: 'term-stale'
      }
    })
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-2',
        dispatchId: 'ctx-2',
        parentPaneKey: currentParentPaneKey,
        parentTerminalHandle: 'term-current'
      }
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toEqual({
      taskId: 'task-2',
      dispatchId: 'ctx-2',
      parentPaneKey: currentParentPaneKey,
      parentTerminalHandle: 'term-current'
    })
  })

  it('uses existing orchestration fields only as fallback for the same runtime dispatch', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'
    const parentPaneKey = 'tab-parent:22222222-2222-4222-8222-222222222222'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentPaneKey,
        coordinatorHandle: 'term-stale-coordinator'
      }
    })
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        coordinatorHandle: 'term-current-coordinator'
      }
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toEqual({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      parentPaneKey,
      coordinatorHandle: 'term-current-coordinator'
    })
  })

  it('keeps current payload orchestration ahead of a stale runtime map entry', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'

    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentTerminalHandle: 'term-stale'
      }
    })
    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex',
      orchestration: {
        taskId: 'task-2',
        dispatchId: 'ctx-2',
        parentTerminalHandle: 'term-current'
      }
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toEqual({
      taskId: 'task-2',
      dispatchId: 'ctx-2',
      parentTerminalHandle: 'term-current'
    })
  })

  it('fills already-synced runtime orchestration metadata into new live entries', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'
    const parentPaneKey = 'tab-parent:22222222-2222-4222-8222-222222222222'

    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentPaneKey
      }
    })
    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex'
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toMatchObject({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      parentPaneKey
    })
  })

  it('clears stale live orchestration when a reused pane starts non-orchestrated work', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'done',
      prompt: 'finished child',
      agentType: 'codex',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentTerminalHandle: 'term-parent'
      }
    })
    store.getState().setRuntimeAgentOrchestrationByPaneKey({})
    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'manual follow-up',
      agentType: 'codex'
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toBeUndefined()
  })

  it('preserves stale live orchestration for final done rows', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'

    store.getState().setAgentStatus(childPaneKey, {
      state: 'working',
      prompt: 'child agent',
      agentType: 'codex',
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentTerminalHandle: 'term-parent'
      }
    })
    store.getState().setRuntimeAgentOrchestrationByPaneKey({})
    store.getState().setAgentStatus(childPaneKey, {
      state: 'done',
      prompt: 'child finished',
      agentType: 'codex'
    })

    expect(store.getState().agentStatusByPaneKey[childPaneKey].orchestration).toEqual({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      parentTerminalHandle: 'term-parent'
    })
  })

  it('fills runtime orchestration metadata into retained entries', () => {
    const store = createTestStore()
    const childPaneKey = 'tab-child:11111111-1111-4111-8111-111111111111'
    const parentPaneKey = 'tab-parent:22222222-2222-4222-8222-222222222222'
    const now = Date.now()
    const entry: AgentStatusEntry = {
      state: 'done',
      prompt: 'child agent',
      updatedAt: now,
      stateStartedAt: now,
      paneKey: childPaneKey,
      stateHistory: []
    }
    const retained: RetainedAgentEntry = {
      entry,
      worktreeId: 'wt-1',
      tab: makeTab({ id: 'tab-child', worktreeId: 'wt-1', title: 'codex' }),
      agentType: 'codex',
      startedAt: now
    }

    store.getState().retainAgents([retained])
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [childPaneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        parentPaneKey
      }
    })

    expect(
      store.getState().retainedAgentsByPaneKey[childPaneKey].entry.orchestration
    ).toMatchObject({
      taskId: 'task-1',
      dispatchId: 'ctx-1',
      parentPaneKey
    })
  })
})

describe('agent status tool + assistant fields', () => {
  // Why: setAgentStatus schedules a real 30-minute freshness setTimeout via
  // queueMicrotask. Without fake timers those handles leak into the test
  // process and keep vitest alive past the run.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes toolName, toolInput, and lastAssistantMessage straight onto the entry', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', {
      state: 'working',
      prompt: 'Edit the config',
      agentType: 'claude',
      toolName: 'Edit',
      toolInput: '/src/config.ts',
      lastAssistantMessage: 'Edited config.ts'
    })
    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(entry.toolName).toBe('Edit')
    expect(entry.toolInput).toBe('/src/config.ts')
    expect(entry.lastAssistantMessage).toBe('Edited config.ts')
  })

  it('clears fields to undefined when a later payload omits them', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', {
      state: 'working',
      prompt: 'Edit the config',
      agentType: 'claude',
      toolName: 'Edit',
      toolInput: '/src/config.ts',
      lastAssistantMessage: 'Edited config.ts'
    })
    // Why: the main-process cache is the source of truth for tool/assistant
    // fields — a fresh-turn reset surfaces as undefined on the payload, and
    // the store must not fall back to the prior entry's values.
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'Next step', agentType: 'claude' })
    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(entry.toolName).toBeUndefined()
    expect(entry.toolInput).toBeUndefined()
    expect(entry.lastAssistantMessage).toBeUndefined()
  })

  it('preserves prior agentType when payload omits it', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', agentType: 'claude' })
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2' })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('claude')
  })

  it('preserves prior agentType when payload sends the "unknown" sentinel', () => {
    // Why: 'unknown' is the sentinel for "agent didn't identify itself". A
    // later ping that loses the identity must not stomp a well-known prior
    // identity (e.g. 'claude' learned from an earlier hook ping), or the UI
    // label/icon would flicker from "Claude" to the neutral "Agent".
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', agentType: 'claude' })
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2', agentType: 'unknown' })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('claude')
  })

  it('preserves active pane agentType when a nested hook sends a different known value', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', agentType: 'codex' })
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2', agentType: 'claude' })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('codex')
  })

  it('ignores nested done while the parent pane agent is still active', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const setGeneratedTabTitleFromAgentPrompt = vi.fn()
    store.setState({ setGeneratedTabTitleFromAgentPrompt } as Partial<AppState>)
    store
      .getState()
      .setAgentStatus(
        'tab-1:1',
        { state: 'working', prompt: 'parent codex', agentType: 'codex' },
        'codex',
        { updatedAt: 1_000, stateStartedAt: 1_000 }
      )
    const firstEpoch = store.getState().agentStatusEpoch

    store.getState().setAgentStatus(
      'tab-1:1',
      {
        state: 'done',
        prompt: 'nested claude',
        agentType: 'claude',
        toolName: 'Read',
        toolInput: '00-review-context.md',
        lastAssistantMessage: 'child finished'
      },
      'claude',
      { updatedAt: 1_100, stateStartedAt: 1_100 }
    )

    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(entry).toMatchObject({
      state: 'working',
      prompt: 'parent codex',
      agentType: 'codex',
      updatedAt: 1_000,
      stateStartedAt: 1_000
    })
    expect(entry.toolName).toBeUndefined()
    expect(entry.toolInput).toBeUndefined()
    expect(entry.lastAssistantMessage).toBeUndefined()
    expect(store.getState().agentStatusEpoch).toBe(firstEpoch)
    expect(setGeneratedTabTitleFromAgentPrompt).toHaveBeenCalledTimes(1)
    expect(setGeneratedTabTitleFromAgentPrompt).toHaveBeenLastCalledWith('tab-1:1', 'parent codex')
  })

  it('allows pane agentType to change after the prior turn is done', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', { state: 'done', prompt: 'p1', agentType: 'codex' })
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p2', agentType: 'claude' })
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('claude')
  })

  it('allows stale active pane agentType to change', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', agentType: 'codex' }, 'codex', {
        updatedAt: 1_000,
        stateStartedAt: 1_000
      })
    store
      .getState()
      .setAgentStatus(
        'tab-1:1',
        { state: 'working', prompt: 'p2', agentType: 'claude' },
        'claude',
        {
          updatedAt: 1_000 + AGENT_STATUS_STALE_AFTER_MS + 1,
          stateStartedAt: 1_000 + AGENT_STATUS_STALE_AFTER_MS + 1
        }
      )
    expect(store.getState().agentStatusByPaneKey['tab-1:1'].agentType).toBe('claude')
  })

  it('keeps global epochs stable for fresh same-state working pings while updating the entry', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(
        'tab-1:1',
        { state: 'working', prompt: 'p1', agentType: 'claude', toolName: 'Read' },
        'claude',
        { updatedAt: 1_000, stateStartedAt: 1_000 }
      )
    const firstEpoch = store.getState().agentStatusEpoch
    const firstSortEpoch = store.getState().sortEpoch

    store
      .getState()
      .setAgentStatus(
        'tab-1:1',
        { state: 'working', prompt: 'p2', agentType: 'claude', toolName: 'Edit' },
        'claude',
        { updatedAt: 2_000, stateStartedAt: 1_000 }
      )

    const sameStateEntry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(sameStateEntry.prompt).toBe('p2')
    expect(sameStateEntry.toolName).toBe('Edit')
    expect(sameStateEntry.updatedAt).toBe(2_000)
    // Why: same-state hook pings are high-frequency and already update the
    // owning row through agentStatusByPaneKey. The global epochs are reserved
    // for state/freshness/final-done changes that can affect aggregate
    // dashboard/sidebar calculations.
    expect(store.getState().agentStatusEpoch).toBe(firstEpoch)
    expect(store.getState().sortEpoch).toBe(firstSortEpoch)

    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'done', prompt: 'p2', agentType: 'claude' }, 'claude', {
        updatedAt: 3_000,
        stateStartedAt: 3_000
      })
    expect(store.getState().agentStatusEpoch).toBe(firstEpoch + 1)
    expect(store.getState().sortEpoch).toBe(firstSortEpoch + 1)
  })

  it('bumps the status epoch, not sort epoch, for same-state done updates', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'done', prompt: 'p1', agentType: 'claude' }, 'claude', {
        updatedAt: 1_000,
        stateStartedAt: 1_000
      })
    const firstEpoch = store.getState().agentStatusEpoch
    const firstSortEpoch = store.getState().sortEpoch

    store.getState().setAgentStatus(
      'tab-1:1',
      {
        state: 'done',
        prompt: 'p1',
        agentType: 'claude',
        lastAssistantMessage: 'final answer'
      },
      'claude',
      { updatedAt: 1_000, stateStartedAt: 1_000 }
    )

    expect(store.getState().agentStatusByPaneKey['tab-1:1'].lastAssistantMessage).toBe(
      'final answer'
    )
    // Why: retained rows need the final done snapshot, but done->done does not
    // change smart-sort class, so only the status/retention epoch should tick.
    expect(store.getState().agentStatusEpoch).toBe(firstEpoch + 1)
    expect(store.getState().sortEpoch).toBe(firstSortEpoch)
  })

  it('bumps global epochs when a stale same-state entry refreshes', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(
        'tab-1:1',
        { state: 'working', prompt: 'stale ping', agentType: 'claude' },
        'claude',
        { updatedAt: 1_000, stateStartedAt: 1_000 }
      )
    const firstEpoch = store.getState().agentStatusEpoch
    const firstSortEpoch = store.getState().sortEpoch

    store
      .getState()
      .setAgentStatus(
        'tab-1:1',
        { state: 'working', prompt: 'fresh again', agentType: 'claude' },
        'claude',
        {
          updatedAt: 1_000 + AGENT_STATUS_STALE_AFTER_MS + 1,
          stateStartedAt: 1_000
        }
      )

    const refreshedEntry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(refreshedEntry.prompt).toBe('fresh again')
    // Why: a stale same-state refresh can promote the worktree back into a
    // smart-sort attention class, so both freshness and sort epochs must tick.
    expect(store.getState().agentStatusEpoch).toBe(firstEpoch + 1)
    expect(store.getState().sortEpoch).toBe(firstSortEpoch + 1)
  })
})

describe('agent status PR refresh handoff', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('enqueues an active PR refresh for the owning worktree when an agent completes', async () => {
    vi.useFakeTimers()
    const enqueuePRRefresh = stubGitHubPRRefreshApi()
    const store = createTestStore()
    seedAgentPRRefreshFixture(store, ['pr'])

    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'create a PR', agentType: 'codex' })
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'done', prompt: 'create a PR', agentType: 'codex' })

    await flushMicrotasks()

    expect(enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath: '/repo',
        branch: 'feature/pr-from-agent',
        worktreeId: 'wt-1',
        linkedPRNumber: null
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('uses hook worktree attribution for PR refresh when the agent tab is not mounted', async () => {
    vi.useFakeTimers()
    const enqueuePRRefresh = stubGitHubPRRefreshApi()
    const store = createTestStore()
    seedAgentPRRefreshFixture(store, ['pr'])
    store.setState({ tabsByWorktree: { 'wt-1': [] } } as Partial<AppState>)
    const paneKey = 'tab-worker:11111111-1111-4111-8111-111111111111'

    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'create a PR', agentType: 'codex' },
        undefined,
        undefined,
        { tabId: 'tab-worker', worktreeId: 'wt-1', terminalHandle: 'term-worker' }
      )
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'done', prompt: 'create a PR', agentType: 'codex' },
        undefined,
        undefined,
        { tabId: 'tab-worker', worktreeId: 'wt-1', terminalHandle: 'term-worker' }
      )

    await flushMicrotasks()

    expect(enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath: '/repo',
        branch: 'feature/pr-from-agent',
        worktreeId: 'wt-1',
        linkedPRNumber: null
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('does not spend a PR refresh when no status lane or PR surface is visible', async () => {
    vi.useFakeTimers()
    const enqueuePRRefresh = stubGitHubPRRefreshApi()
    const store = createTestStore()
    seedAgentPRRefreshFixture(store, ['comment'])

    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'create a PR', agentType: 'codex' })
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'done', prompt: 'create a PR', agentType: 'codex' })

    await flushMicrotasks()

    expect(enqueuePRRefresh).not.toHaveBeenCalled()
  })

  it('does not repeat the refresh for same-state done detail updates', async () => {
    vi.useFakeTimers()
    const enqueuePRRefresh = stubGitHubPRRefreshApi()
    const store = createTestStore()
    seedAgentPRRefreshFixture(store, ['pr'])

    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'create a PR', agentType: 'codex' })
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'done', prompt: 'create a PR', agentType: 'codex' })
    store.getState().setAgentStatus('tab-1:0', {
      state: 'done',
      prompt: 'create a PR',
      agentType: 'codex',
      lastAssistantMessage: 'Opened https://github.com/acme/orca/pull/42'
    })

    await flushMicrotasks()

    expect(enqueuePRRefresh).toHaveBeenCalledTimes(1)
  })
})

describe('agent status stateStartedAt', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('carries stateStartedAt forward across same-state pings', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1' }, 'claude')
    const firstStart = store.getState().agentStatusByPaneKey['tab-1:1'].stateStartedAt

    // Advance 5s and re-ping with same state but different prompt/tool fields
    vi.setSystemTime(new Date('2026-04-09T12:00:05.000Z'))
    store
      .getState()
      .setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1', toolName: 'Edit' }, 'claude')

    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    // Why: stateStartedAt is the invariant we are protecting — it must survive
    // tool/prompt pings within the same state, while updatedAt advances.
    expect(entry.stateStartedAt).toBe(firstStart)
    expect(entry.updatedAt).toBe(new Date('2026-04-09T12:00:05.000Z').getTime())
  })

  it('resets stateStartedAt when the state changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'p1' }, 'claude')
    const workingStart = store.getState().agentStatusByPaneKey['tab-1:1'].stateStartedAt

    vi.setSystemTime(new Date('2026-04-09T12:00:10.000Z'))
    store.getState().setAgentStatus('tab-1:1', { state: 'done', prompt: 'p1' }, 'claude')

    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(entry.stateStartedAt).toBe(new Date('2026-04-09T12:00:10.000Z').getTime())
    expect(entry.stateStartedAt).not.toBe(workingStart)
    // history should capture the working state's true start
    expect(entry.stateHistory).toHaveLength(1)
    expect(entry.stateHistory[0].state).toBe('working')
    expect(entry.stateHistory[0].startedAt).toBe(workingStart)
  })

  it('uses IPC snapshot timing instead of restamping restored entries as fresh', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(
        'tab-1:1',
        { state: 'working', prompt: 'p1', agentType: 'claude' },
        'claude',
        {
          updatedAt: new Date('2026-04-09T10:00:00.000Z').getTime(),
          stateStartedAt: new Date('2026-04-09T09:55:00.000Z').getTime()
        }
      )

    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(entry.updatedAt).toBe(new Date('2026-04-09T10:00:00.000Z').getTime())
    expect(entry.stateStartedAt).toBe(new Date('2026-04-09T09:55:00.000Z').getTime())
  })

  it('ignores an older snapshot when a newer live event already updated the pane', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(
        'tab-1:1',
        { state: 'working', prompt: 'fresh', agentType: 'claude' },
        'claude',
        { updatedAt: 2_000, stateStartedAt: 2_000 }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:1',
        { state: 'done', prompt: 'stale', agentType: 'claude' },
        'claude',
        { updatedAt: 1_000, stateStartedAt: 1_000 }
      )

    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(entry.state).toBe('working')
    expect(entry.prompt).toBe('fresh')
    expect(entry.updatedAt).toBe(2_000)
  })
})

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
