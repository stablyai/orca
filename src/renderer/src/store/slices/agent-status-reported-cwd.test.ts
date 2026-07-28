import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  collectHibernatedCompletionEvidenceForWorktree,
  collectSleepingAgentSessionRecordsForWorktree
} from './agent-status'
import { createTestStore, makeTab } from './store-test-helpers'

const PANE_KEY = 'tab-1:leaf-1'
const OWNER_CWD = '/Users/dev/repo'
const SCRATCH_CWD = '/Users/dev/repo/.claude/worktrees/scratch'

afterEach(() => {
  vi.useRealTimers()
})

function seedTabs(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
  } as Partial<AppState>)
}

function setStatusWithMetadata(
  store: ReturnType<typeof createTestStore>,
  payload: { state: 'working' | 'done'; prompt: string; agentType?: 'claude' | 'codex' | 'pi' },
  metadata?: { reportedCwd?: string | null }
): void {
  store
    .getState()
    .setAgentStatus(
      PANE_KEY,
      payload,
      undefined,
      undefined,
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      metadata
    )
}

function reportedCwd(store: ReturnType<typeof createTestStore>): string | undefined {
  return store.getState().agentStatusByPaneKey[PANE_KEY]?.reportedCwd
}

describe('agent status reported cwd', () => {
  it('merges a cwd-only accepted update and preserves it across events that carry none', () => {
    const store = createTestStore()
    seedTabs(store)

    setStatusWithMetadata(
      store,
      { state: 'working', prompt: 'go', agentType: 'claude' },
      {
        reportedCwd: SCRATCH_CWD
      }
    )
    expect(reportedCwd(store)).toBe(SCRATCH_CWD)

    // Why: a same-root transition with no cwd must not blank the known location.
    setStatusWithMetadata(store, { state: 'done', prompt: 'go', agentType: 'claude' })
    expect(reportedCwd(store)).toBe(SCRATCH_CWD)

    setStatusWithMetadata(
      store,
      { state: 'working', prompt: 'again', agentType: 'claude' },
      {
        reportedCwd: OWNER_CWD
      }
    )
    expect(reportedCwd(store)).toBe(OWNER_CWD)
  })

  it('publishes a fresh entry for an update that only moves the location', () => {
    const store = createTestStore()
    seedTabs(store)

    setStatusWithMetadata(
      store,
      { state: 'working', prompt: 'go', agentType: 'claude' },
      {
        reportedCwd: OWNER_CWD
      }
    )
    const before = store.getState().agentStatusByPaneKey[PANE_KEY]

    setStatusWithMetadata(
      store,
      { state: 'working', prompt: 'go', agentType: 'claude' },
      {
        reportedCwd: SCRATCH_CWD
      }
    )
    const after = store.getState().agentStatusByPaneKey[PANE_KEY]

    // Why: sidebar cards diff entry identity, so a cwd-only move must publish a new object.
    expect(after).not.toBe(before)
    expect(after.reportedCwd).toBe(SCRATCH_CWD)
    expect(after.state).toBe(before.state)
    expect(after.prompt).toBe(before.prompt)
  })

  it('clears the location when main sends an explicit null', () => {
    const store = createTestStore()
    seedTabs(store)

    setStatusWithMetadata(
      store,
      { state: 'working', prompt: 'go', agentType: 'claude' },
      {
        reportedCwd: SCRATCH_CWD
      }
    )
    setStatusWithMetadata(
      store,
      { state: 'working', prompt: 'go', agentType: 'claude' },
      {
        reportedCwd: null
      }
    )

    expect(reportedCwd(store)).toBeUndefined()
    expect('reportedCwd' in store.getState().agentStatusByPaneKey[PANE_KEY]).toBe(false)
  })

  it('ignores a nested child agent that inherited the live root pane', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    seedTabs(store)

    setStatusWithMetadata(
      store,
      { state: 'working', prompt: 'root', agentType: 'claude' },
      {
        reportedCwd: OWNER_CWD
      }
    )
    // Why: a foreign agentType while the root turn is live is nested child traffic.
    setStatusWithMetadata(
      store,
      { state: 'working', prompt: 'child', agentType: 'codex' },
      {
        reportedCwd: SCRATCH_CWD
      }
    )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY].agentType).toBe('claude')
    expect(reportedCwd(store)).toBe(OWNER_CWD)
  })

  it('drops the cached location when a different root agent takes the pane', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    seedTabs(store)

    setStatusWithMetadata(
      store,
      { state: 'working', prompt: 'root', agentType: 'claude' },
      {
        reportedCwd: SCRATCH_CWD
      }
    )
    setStatusWithMetadata(store, { state: 'done', prompt: 'root', agentType: 'claude' })
    setStatusWithMetadata(store, { state: 'working', prompt: 'next', agentType: 'codex' })

    expect(store.getState().agentStatusByPaneKey[PANE_KEY].agentType).toBe('codex')
    expect(reportedCwd(store)).toBeUndefined()
  })

  it('strips the location from retained completion evidence', () => {
    const store = createTestStore()
    seedTabs(store)

    setStatusWithMetadata(
      store,
      { state: 'done', prompt: 'finished', agentType: 'claude' },
      {
        reportedCwd: SCRATCH_CWD
      }
    )

    const retained = collectHibernatedCompletionEvidenceForWorktree(store.getState(), 'wt-1', [
      PANE_KEY
    ])
    expect(retained).toHaveLength(1)
    expect(retained[0].entry.reportedCwd).toBeUndefined()
    expect('reportedCwd' in retained[0].entry).toBe(false)
    // Why: stripping the copy must not disturb the live entry it was cloned from.
    expect(reportedCwd(store)).toBe(SCRATCH_CWD)
  })

  it('never captures the location into a sleeping session record', () => {
    const store = createTestStore()
    seedTabs(store)

    store.getState().setAgentStatus(
      PANE_KEY,
      { state: 'working', prompt: 'sleep me', agentType: 'codex' },
      undefined,
      undefined,
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      {
        reportedCwd: SCRATCH_CWD,
        providerSession: { key: 'session_id', id: 'codex-session-1' }
      }
    )

    const records = collectSleepingAgentSessionRecordsForWorktree(store.getState(), 'wt-1')
    expect(records[PANE_KEY]).toBeDefined()
    expect((records[PANE_KEY] as Record<string, unknown>).reportedCwd).toBeUndefined()
  })
})
