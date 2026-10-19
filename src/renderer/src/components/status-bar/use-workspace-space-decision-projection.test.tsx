// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useStore } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store/types'
import {
  createTestStore,
  makeOpenFile,
  makeTab,
  makeWorktree
} from '../../store/slices/store-test-helpers'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { resetAgentStatusEpochClockForTests } from '@/lib/agent-status-epoch-clock'
import { useWorkspaceSpaceManagerBindings } from './use-workspace-space-manager-bindings'
import { useWorkspaceSpaceDecisionProjection } from './use-workspace-space-decision-projection'

let store: ReturnType<typeof createTestStore>
vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    <Result,>(selector: (state: AppState) => Result) => useStore(store, selector),
    { getState: () => store.getState() }
  )
}))

function row(
  worktreeId: string,
  executionHostId: 'local' | 'ssh:host' = 'local'
): WorkspaceSpaceWorktree {
  return {
    worktreeId,
    executionHostId,
    repoId: 'repo',
    repoDisplayName: 'Repo',
    repoPath: '/repo',
    displayName: worktreeId,
    path: `/repo/${worktreeId}`,
    branch: 'main',
    isMainWorktree: false,
    isRemote: executionHostId !== 'local',
    isSparse: false,
    canDelete: true,
    lastActivityAt: 0,
    status: 'ok',
    error: null,
    scannedAt: 0,
    sizeBytes: 0,
    reclaimableBytes: 0,
    skippedEntryCount: 0,
    topLevelItems: [],
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0
  }
}

function entry(paneKey: string, overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: '',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: [],
    ...overrides
  }
}

function seed(rows: WorkspaceSpaceWorktree[]) {
  store.setState({
    worktreesByRepo: { repo: rows.map((r) => makeWorktree({ id: r.worktreeId, repoId: 'repo' })) },
    tabsByWorktree: Object.fromEntries(
      rows.map((r) => [
        r.worktreeId,
        [makeTab({ id: `${r.worktreeId}-tab`, worktreeId: r.worktreeId })]
      ])
    ),
    workspaceSpaceAnalysis: {
      scannedAt: 1,
      worktrees: rows,
      repos: [],
      totalSizeBytes: 0,
      reclaimableBytes: 0,
      worktreeCount: rows.length,
      scannedWorktreeCount: rows.length,
      unavailableWorktreeCount: 0
    },
    refreshGitHubForWorktreeIfStale: vi.fn(async () => {})
  })
}

function mountProjection() {
  return renderHook(() => useWorkspaceSpaceDecisionProjection(useWorkspaceSpaceManagerBindings()))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  store = createTestStore()
  resetAgentStatusEpochClockForTests()
})
afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetAgentStatusEpochClockForTests()
})

describe('mounted Space decision projection', () => {
  it('reads each owned agent instead of every global record on each title publication', () => {
    seed(Array.from({ length: 20 }, (_, i) => row(`w${i}`)))
    let liveProbes = 0,
      retainedProbes = 0
    const live: AppState['agentStatusByPaneKey'] = {}
    const retained: AppState['retainedAgentsByPaneKey'] = {}
    for (let i = 0; i < 10; i += 1) {
      const paneKey = `w${i}-tab:legacy`
      live[paneKey] = {
        ...entry(paneKey),
        get state(): AgentStatusEntry['state'] {
          liveProbes += 1
          return 'working'
        }
      }
    }
    for (let i = 0; i < 40; i += 1) {
      const worktreeId = `w${i % 20}`
      retained[`completed-${i}`] = {
        entry: entry(`completed-${i}:legacy`, { state: 'done' }),
        get worktreeId() {
          retainedProbes += 1
          return worktreeId
        },
        tab: makeTab({ id: `completed-${i}`, worktreeId }),
        agentType: 'claude',
        startedAt: 0
      }
    }
    store.setState({ agentStatusByPaneKey: live, retainedAgentsByPaneKey: retained })
    const view = mountProjection()
    liveProbes = 0
    retainedProbes = 0
    for (let i = 0; i < 5; i += 1) {
      act(() => store.getState().setRuntimePaneTitle('w0-tab', 0, `Ordinary command ${i}`))
    }
    expect(view.result.current.decisionDetailsByWorktreeId.size).toBe(20)
    expect({ liveProbes, retainedProbes }).toEqual({ liveProbes: 50, retainedProbes: 200 })
  })

  it('updates from real status, retention, draft, tab and source-row changes', () => {
    seed([row('w0'), row('w1')])
    const view = mountProjection()
    const details = () => view.result.current.decisionDetailsByWorktreeId.get('local|w0')
    act(() =>
      store.getState().setAgentStatus('w0-tab:legacy', {
        agentType: 'custom-non-icon-agent',
        state: 'working',
        prompt: 'Generated task'
      })
    )
    expect(details()?.activeAgentCount).toBe(1)
    act(() =>
      store.getState().setAgentStatus('w0-tab:legacy', {
        agentType: 'custom-non-icon-agent',
        state: 'done',
        prompt: 'Generated task'
      })
    )
    expect(details()?.activeAgentCount).toBe(0)
    act(() =>
      store.getState().retainAgents([
        {
          entry: entry('completed:legacy', { state: 'done' }),
          worktreeId: 'w0',
          tab: makeTab({ id: 'completed', worktreeId: 'w0' }),
          agentType: 'claude',
          startedAt: 0
        }
      ])
    )
    expect(details()?.completedAgentCount).toBe(1)
    act(() => store.setState({ openFiles: [makeOpenFile({ id: 'file', worktreeId: 'w0' })] }))
    act(() => store.getState().setEditorDraft('file', 'Changed content'))
    expect(details()?.dirtyEditorBufferCount).toBe(1)
    act(() => store.setState({ tabsByWorktree: { w0: [] } }))
    expect(details()?.terminalTabCount).toBe(0)
    act(() => store.setState({ workspaceSpaceAnalysis: null }))
    expect(view.result.current.decisionDetailsByWorktreeId.size).toBe(0)
  })

  it('keeps special own keys and migration workspace-or-tab ownership across host collisions', () => {
    seed([row('w0'), row('w0', 'ssh:host'), row('w1')])
    store.setState({
      tabsByWorktree: {
        w0: [makeTab({ id: 'shared', worktreeId: 'w0' })],
        w1: [makeTab({ id: 'shared', worktreeId: 'w0' })]
      },
      agentStatusByPaneKey: Object.fromEntries([
        ['__proto__', entry('shared:legacy', { agentType: 'custom-non-icon-agent' })],
        ['constructor', entry('shared:legacy')],
        ['2', entry('wrong:legacy')],
        ['shared:legacy', entry('other:legacy')]
      ]),
      migrationUnsupportedByPtyId: Object.fromEntries<
        AppState['migrationUnsupportedByPtyId'][string]
      >([
        [
          '__proto__',
          {
            ptyId: 'm1',
            worktreeId: 'w0',
            tabId: 'shared',
            source: 'local',
            reason: 'legacy-numeric-pane-key',
            updatedAt: 1
          }
        ],
        [
          'missing-owner',
          {
            ptyId: 'm3',
            tabId: 'shared',
            source: 'local',
            reason: 'legacy-numeric-pane-key',
            updatedAt: 1
          }
        ],
        [
          'constructor',
          {
            ptyId: 'm2',
            worktreeId: 'w0',
            tabId: '',
            paneKey: 'shared:legacy',
            source: 'local',
            reason: 'legacy-numeric-pane-key',
            updatedAt: 1
          }
        ]
      ]),
      retainedAgentsByPaneKey: Object.fromEntries([
        [
          '__proto__',
          {
            entry: entry('done:legacy', { state: 'done' }),
            worktreeId: 'w0',
            tab: makeTab({ id: 'done', worktreeId: 'w0' }),
            agentType: 'claude',
            startedAt: 0
          }
        ],
        [
          'constructor',
          {
            entry: entry('working:legacy'),
            worktreeId: 'w0',
            tab: makeTab({ id: 'working', worktreeId: 'w0' }),
            agentType: 'claude',
            startedAt: 0
          }
        ]
      ])
    })
    const view = mountProjection()
    const results = view.result.current.decisionDetailsByWorktreeId
    expect(results.get('local|w0')).toMatchObject({ activeAgentCount: 5, completedAgentCount: 1 })
    expect(results.get('ssh:host|w0')).toMatchObject({
      activeAgentCount: 5,
      completedAgentCount: 1
    })
    expect(results.get('local|w1')).toMatchObject({ activeAgentCount: 4, completedAgentCount: 0 })
  })

  it('does not enumerate global records when there are no scan rows', () => {
    seed([])
    const trap = {
      ownKeys() {
        throw new Error('empty analysis enumerated global agent records')
      }
    }
    store.setState({
      agentStatusByPaneKey: new Proxy<AppState['agentStatusByPaneKey']>({}, trap),
      migrationUnsupportedByPtyId: new Proxy<AppState['migrationUnsupportedByPtyId']>({}, trap),
      retainedAgentsByPaneKey: new Proxy<AppState['retainedAgentsByPaneKey']>({}, trap)
    })
    expect(mountProjection().result.current.decisionDetailsByWorktreeId.size).toBe(0)
  })

  it('samples freshness on epoch changes without reusing a stale verdict', () => {
    seed([row('w0')])
    store.setState({ agentStatusByPaneKey: { 'w0-tab:legacy': entry('w0-tab:legacy') } })
    const view = mountProjection()
    expect(view.result.current.decisionDetailsByWorktreeId.get('local|w0')?.activeAgentCount).toBe(
      1
    )
    act(() => {
      vi.setSystemTime(3_000_000)
      store.setState({ agentStatusEpoch: store.getState().agentStatusEpoch + 1 })
    })
    expect(view.result.current.decisionDetailsByWorktreeId.get('local|w0')?.activeAgentCount).toBe(
      0
    )
  })
})
