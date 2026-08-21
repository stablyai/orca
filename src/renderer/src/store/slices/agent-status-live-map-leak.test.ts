/** Regression for #9872: missed pane teardown must not let heavy live status rows grow unbounded. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { MAX_LIVE_AGENT_STATUSES } from './agent-status'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'
import type { AppState } from '../types'

// Use the production payload limits so the regression represents the leaked byte weight.
const BIG_ASSISTANT_MESSAGE = 'a'.repeat(8 * 1024)
const BIG_INTERACTIVE_PROMPT = 'q'.repeat(16 * 1024)

function seedWorktree(store: ReturnType<typeof createTestStore>): void {
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
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' })]
    },
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-live', worktreeId: 'wt-1' })]
    },
    terminalLayoutsByTabId: {
      'tab-live': {
        root: { type: 'leaf', leafId: 'leaf-live' },
        activeLeafId: 'leaf-live',
        expandedLeafId: null
      }
    }
  } as Partial<AppState>)
}

function donePayload(index: number): ParsedAgentStatusPayload {
  return {
    state: 'done',
    prompt: `prompt ${index}`,
    agentType: 'claude',
    lastAssistantMessage: BIG_ASSISTANT_MESSAGE,
    interactivePrompt: BIG_INTERACTIVE_PROMPT
  } as ParsedAgentStatusPayload
}

function workingPayload(index: number): ParsedAgentStatusPayload {
  return {
    state: 'working',
    prompt: `busy ${index}`,
    agentType: 'claude'
  } as ParsedAgentStatusPayload
}

function sleepingRecord(paneKey: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: paneKey.slice(0, paneKey.indexOf(':')),
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live'
  }
}

function setAgentAt(
  store: ReturnType<typeof createTestStore>,
  paneKey: string,
  payload: ParsedAgentStatusPayload,
  updatedAt?: number
): void {
  const tabId = paneKey.slice(0, paneKey.indexOf(':'))
  store
    .getState()
    .setAgentStatus(
      paneKey,
      payload,
      undefined,
      updatedAt === undefined ? undefined : { updatedAt },
      {
        tabId,
        worktreeId: 'wt-1'
      }
    )
}

/** Add rows for leaves absent from a mounted tab's rooted layout. */
function churnDeadLeaves(
  store: ReturnType<typeof createTestStore>,
  count: number,
  makePayload: (i: number) => ParsedAgentStatusPayload = donePayload
): void {
  for (let i = 0; i < count; i++) {
    setAgentAt(store, `tab-live:dead-${i}`, makePayload(i))
  }
}

/** Add fresh rows whose pane liveness cannot be proven from renderer layouts. */
function churnFreshUnprovable(store: ReturnType<typeof createTestStore>, count: number): void {
  for (let i = 0; i < count; i++) {
    setAgentAt(store, `gone-${i}:leaf-${i}`, workingPayload(i))
  }
}

describe('agentStatusByPaneKey stays bounded (leak regression #9872)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps the live map at the limit, evicting the oldest dead-leaf orphans', () => {
    const store = createTestStore()
    seedWorktree(store)

    const total = MAX_LIVE_AGENT_STATUSES + 1500
    churnDeadLeaves(store, total)

    const live = store.getState().agentStatusByPaneKey
    expect(Object.keys(live).length).toBe(MAX_LIVE_AGENT_STATUSES)
    expect(live[`tab-live:dead-${total - 1}`]).toBeDefined()
    expect(live['tab-live:dead-0']).toBeUndefined()
  })

  it("never evicts a live pane's working agent", () => {
    const store = createTestStore()
    seedWorktree(store)
    setAgentAt(store, 'tab-live:leaf-live', workingPayload(0))

    churnDeadLeaves(store, MAX_LIVE_AGENT_STATUSES + 1500)

    expect(store.getState().agentStatusByPaneKey['tab-live:leaf-live']?.state).toBe('working')
  })

  it("never evicts a live pane's waiting or blocked row, even under the hard-cap fallback", () => {
    const store = createTestStore()
    seedWorktree(store)
    store.setState({
      terminalLayoutsByTabId: {
        'tab-live': {
          root: { type: 'leaf', leafId: 'leaf-live' },
          activeLeafId: 'leaf-live',
          expandedLeafId: null
        },
        'tab-w': {
          root: { type: 'leaf', leafId: 'leaf-w' },
          activeLeafId: 'leaf-w',
          expandedLeafId: null
        },
        'tab-b': {
          root: { type: 'leaf', leafId: 'leaf-b' },
          activeLeafId: 'leaf-b',
          expandedLeafId: null
        }
      }
    } as Partial<AppState>)
    setAgentAt(store, 'tab-w:leaf-w', {
      state: 'waiting',
      prompt: 'needs input',
      agentType: 'claude'
    } as ParsedAgentStatusPayload)
    setAgentAt(store, 'tab-b:leaf-b', {
      state: 'blocked',
      prompt: 'perm prompt',
      agentType: 'claude'
    } as ParsedAgentStatusPayload)

    churnFreshUnprovable(store, MAX_LIVE_AGENT_STATUSES + 1500)

    const live = store.getState().agentStatusByPaneKey
    expect(live['tab-w:leaf-w']?.state).toBe('waiting')
    expect(live['tab-b:leaf-b']?.state).toBe('blocked')
  })

  it('bounds the map when fresh unprovable rows dominate, without evicting a live pane', () => {
    const store = createTestStore()
    seedWorktree(store)
    setAgentAt(store, 'tab-live:leaf-live', donePayload(-1))

    churnFreshUnprovable(store, MAX_LIVE_AGENT_STATUSES + 200)

    const live = store.getState().agentStatusByPaneKey
    expect(Object.keys(live).length).toBe(MAX_LIVE_AGENT_STATUSES)
    expect(live['tab-live:leaf-live']?.state).toBe('done')
  })

  it('keeps fresh rows of rootless / empty-snapshot / no-renderer-tab panes (live agents, #2962)', () => {
    const store = createTestStore()
    seedWorktree(store)
    store.setState({
      tabsByWorktree: {
        'wt-1': [
          makeTab({ id: 'tab-live', worktreeId: 'wt-1' }),
          makeTab({ id: 'bg-empty', worktreeId: 'wt-1' })
        ]
      },
      terminalLayoutsByTabId: {
        'tab-live': {
          root: { type: 'leaf', leafId: 'leaf-live' },
          activeLeafId: 'leaf-live',
          expandedLeafId: null
        },
        'bg-empty': { root: null, activeLeafId: null, expandedLeafId: null },
        'bg-bound': {
          root: null,
          activeLeafId: 'leaf-bound',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-bound': 'pty-1' }
        }
      }
    } as Partial<AppState>)
    setAgentAt(store, 'bg-empty:leaf-bg', {
      state: 'waiting',
      prompt: 'needs input',
      agentType: 'claude'
    } as ParsedAgentStatusPayload)
    setAgentAt(store, 'bg-bound:leaf-bound', donePayload(-2))
    setAgentAt(store, 'worker-tab:leaf-worker', workingPayload(-3))

    churnDeadLeaves(store, MAX_LIVE_AGENT_STATUSES + 200)

    const live = store.getState().agentStatusByPaneKey
    expect(live['bg-empty:leaf-bg']?.state).toBe('waiting')
    expect(live['bg-bound:leaf-bound']?.state).toBe('done')
    expect(live['worker-tab:leaf-worker']?.state).toBe('working')
  })

  it('evicts an idle unprovable orphan once past the stale window, keeping fresh ones', () => {
    vi.useFakeTimers()
    const late = new Date('2026-07-22T00:00:00.000Z').getTime()
    vi.setSystemTime(late)
    const store = createTestStore()
    seedWorktree(store)

    setAgentAt(store, 'gone-stale:leaf', workingPayload(0), late - AGENT_STATUS_STALE_AFTER_MS - 1)
    for (let i = 0; i < MAX_LIVE_AGENT_STATUSES; i++) {
      setAgentAt(store, `gone-fresh-${i}:leaf`, workingPayload(i), late)
    }

    const live = store.getState().agentStatusByPaneKey
    expect(Object.keys(live).length).toBe(MAX_LIVE_AGENT_STATUSES)
    expect(live['gone-stale:leaf']).toBeUndefined()
    expect(live['gone-fresh-0:leaf']?.state).toBe('working')
  })

  it('under cap: no eviction', () => {
    const store = createTestStore()
    seedWorktree(store)

    churnDeadLeaves(store, 10)

    expect(Object.keys(store.getState().agentStatusByPaneKey).length).toBe(10)
  })

  it('purges recovery and launch records for evicted pane keys', () => {
    const store = createTestStore()
    seedWorktree(store)

    churnDeadLeaves(store, MAX_LIVE_AGENT_STATUSES)
    const evictedPaneKey = 'tab-live:dead-0'
    const keptPaneKey = 'tab-live:dead-1'
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        [evictedPaneKey]: sleepingRecord(evictedPaneKey),
        [keptPaneKey]: sleepingRecord(keptPaneKey)
      },
      agentLaunchConfigByPaneKey: {
        [evictedPaneKey]: {
          launchConfig: { agentArgs: '', agentEnv: {} },
          registeredAt: 1,
          identity: {}
        },
        [keptPaneKey]: {
          launchConfig: { agentArgs: '', agentEnv: {} },
          registeredAt: 1,
          identity: {}
        }
      }
    } as Partial<AppState>)

    setAgentAt(store, 'tab-live:dead-extra', donePayload(MAX_LIVE_AGENT_STATUSES))

    const state = store.getState()
    expect(state.agentStatusByPaneKey[evictedPaneKey]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[evictedPaneKey]).toBeUndefined()
    expect(state.agentLaunchConfigByPaneKey[evictedPaneKey]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[keptPaneKey]).toBeDefined()
    expect(state.agentLaunchConfigByPaneKey[keptPaneKey]).toBeDefined()
  })

  it('bumps epochs when eviction is the only sort-relevant change', () => {
    const store = createTestStore()
    seedWorktree(store)

    churnDeadLeaves(store, MAX_LIVE_AGENT_STATUSES, workingPayload)
    const existingPaneKey = 'tab-live:dead-0'
    const existing = store.getState().agentStatusByPaneKey[existingPaneKey]
    store.setState({
      agentStatusByPaneKey: {
        ...store.getState().agentStatusByPaneKey,
        'tab-live:dead-extra': {
          ...existing,
          paneKey: 'tab-live:dead-extra'
        }
      }
    } as Partial<AppState>)
    const statusEpochBefore = store.getState().agentStatusEpoch
    const sortEpochBefore = store.getState().sortEpoch

    setAgentAt(store, existingPaneKey, workingPayload(0), existing.updatedAt)

    const state = store.getState()
    expect(Object.keys(state.agentStatusByPaneKey).length).toBe(MAX_LIVE_AGENT_STATUSES)
    expect(state.agentStatusEpoch).toBe(statusEpochBefore + 1)
    expect(state.sortEpoch).toBe(sortEpochBefore + 1)
  })
})
