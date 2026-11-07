import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'

const transport = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: transport.call
}))
vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: transport.subscribe
}))
// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useLiveDashboardSnapshot } from './useLiveDashboardSnapshot'

const NOW = 1_000_000_000
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

const initialAppState = useAppStore.getInitialState()

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
})

afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
  resetHostStructuredAgentsForTests()
  useAppStore.setState(initialAppState, true)
})

function repo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo One',
    badgeColor: '#000',
    repoIcon: { type: 'lucide', name: 'Rocket' },
    addedAt: 1
  }
}

function worktree(): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt-1',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'wt-one',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW
  }
}

function tab(): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'agent',
    customTitle: null,
    generatedTitle: 'Fix the flaky pty test',
    color: null,
    sortOrder: 0,
    createdAt: NOW
  } as TerminalTab
}

function entry(): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'do the thing',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: [],
    agentType: 'claude',
    tabId: TAB_ID,
    worktreeId: 'wt-1'
  }
}

function seed(settings: Partial<GlobalSettings> | null): void {
  useAppStore.setState({
    repos: [repo()],
    worktreesByRepo: { 'repo-1': [worktree()] },
    tabsByWorktree: { 'wt-1': [tab()] },
    agentStatusByPaneKey: { [PANE_KEY]: entry() },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
    settings: settings as GlobalSettings | null
  })
}

// The drawer feeds builder slices directly; omission silently loses fields instead of failing validation.
describe('useLiveDashboardSnapshot', () => {
  // Re-render the same hook to prove host-only changes invalidate it; a fresh mount would conceal missing subscriptions.
  it('re-derives the host-input profile when only a host slice changes', () => {
    seed({ tabAutoGenerateTitle: false })
    useAppStore.setState({
      repos: [{ ...repo(), connectionId: 'conn-1', executionHostId: 'ssh:conn-1' }]
    })
    const { result, rerender } = renderHook(() => useLiveDashboardSnapshot())
    expect(result.current.cards[0].terminalInput?.hostPlatform).toBe('linux')

    useAppStore.setState({
      sshConnectionStates: new Map([
        ['conn-1', { remotePlatform: 'win32' }]
      ]) as unknown as ReturnType<typeof useAppStore.getState>['sshConnectionStates']
    })
    rerender()
    expect(result.current.cards[0].terminalInput?.hostPlatform).toBe('win32')
  })

  it('re-derives saved SSH labels when the target catalog changes', () => {
    seed({ tabAutoGenerateTitle: false })
    useAppStore.setState({
      repos: [{ ...repo(), connectionId: 'target-1', executionHostId: 'ssh:target-1' }]
    })
    const { result, rerender } = renderHook(() => useLiveDashboardSnapshot())
    expect(result.current.cards[0].hostLabel).toBe('target-1')

    useAppStore.setState({ sshTargetLabels: new Map([['target-1', 'Builder']]) })
    rerender()
    expect(result.current.cards[0].hostLabel).toBe('Builder')
  })
})
