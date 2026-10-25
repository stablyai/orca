import { getDefaultSettings } from '../../../../shared/constants'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG,
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as HEALTH
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import { useDashboardPopoutBridge } from './useDashboardPopoutBridge'
const transport = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: transport.call }))
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: transport.subscribe }))
// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
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
  it('feeds the builder the settings that gate generated conversation names', () => {
    seed({ tabAutoGenerateTitle: true })
    const withTitles = renderHook(() => useLiveDashboardSnapshot())
    expect(withTitles.result.current.cards[0].conversationName).toBe('Fix the flaky pty test')

    seed({ tabAutoGenerateTitle: false })
    const withoutTitles = renderHook(() => useLiveDashboardSnapshot())
    expect(withoutTitles.result.current.cards[0].conversationName).toBeUndefined()
  })

  it('carries repo icons through to the drawer', () => {
    seed({ tabAutoGenerateTitle: false })
    const { result } = renderHook(() => useLiveDashboardSnapshot())
    expect(result.current.repoIconsByRepoId).toEqual({
      'repo-1': { type: 'lucide', name: 'Rocket' }
    })
  })

  // Seed host-profile input slices explicitly so missing plumbing cannot degrade drawer previews to client-OS routing.
  it("resolves each card's host-input profile from the slices it does not subscribe to", () => {
    seed({ tabAutoGenerateTitle: false })
    const { result: localResult } = renderHook(() => useLiveDashboardSnapshot())
    expect(localResult.current.cards[0].terminalInput?.hostPlatform).toBe('linux')

    useAppStore.setState({
      repos: [{ ...repo(), connectionId: 'conn-1', executionHostId: 'ssh:conn-1' }],
      sshConnectionStates: new Map([
        ['conn-1', { remotePlatform: 'win32' }]
      ]) as unknown as ReturnType<typeof useAppStore.getState>['sshConnectionStates']
    })
    const { result: sshResult } = renderHook(() => useLiveDashboardSnapshot())
    expect(sshResult.current.cards[0].terminalInput?.hostPlatform).toBe('win32')
  })

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

it('publishes real chat options to main and popout, retaining card candidates and deduplicating/releasing owners', async () => {
  const unsubscribe = vi.fn()
  transport.call.mockResolvedValue({ agents: [{ agent: 'grok', capabilities: {} }] })
  transport.subscribe.mockResolvedValue({ unsubscribe })
  setLocalRuntimeCapabilitiesForTests([CHAT, CATALOG, HEALTH])
  seed({ ...getDefaultSettings('/tmp'), experimentalNativeChat: true })
  useAppStore.setState({
    detectedAgentIds: [],
    worktreesByRepo: { 'repo-1': [worktree(), { ...worktree(), id: 'wt-2' }] }
  })
  const publishSnapshot = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      dashboard: {
        onRevealAgent: () => () => {},
        onPopoutOpenChanged: () => () => {},
        onSnapshotRequested: () => () => {},
        getPopoutOpen: async () => true,
        publishSnapshot
      }
    }
  })
  const view = renderHook(() => {
    useDashboardPopoutBridge(true)
    return useLiveDashboardSnapshot()
  })
  await vi.waitFor(() => expect(transport.subscribe).toHaveBeenCalledOnce())
  await act(async () =>
    transport.subscribe.mock.calls[0][3].onEvent({
      type: 'availability',
      agents: [{ agent: 'grok', state: 'available', chatProgram: 'available' }]
    })
  )
  expect(view.result.current.launchableAgentsByWorktreeId?.['wt-1']).toEqual(['claude', 'grok'])
  expect(view.result.current.launchableAgentsByWorktreeId?.['wt-2']).toEqual(['grok'])
  const lastPublished = () => publishSnapshot.mock.calls.at(-1)?.[0].launchableAgentsByWorktreeId
  await vi.waitFor(() => expect(lastPublished()?.['wt-1']).toEqual(['claude', 'grok']))
  for (const route of [{ projects: [] }, { activeWorkspaceExecutionHostId: 'local' as const }]) {
    const [live, published] = [view.result.current, publishSnapshot.mock.calls.length]
    act(() => useAppStore.setState(route))
    expect(view.result.current).not.toBe(live)
    await vi.waitFor(() => expect(publishSnapshot.mock.calls.length).toBeGreaterThan(published))
  }
  act(() => useAppStore.setState({ worktreesByRepo: {}, tabsByWorktree: {}, folderWorkspaces: [] }))
  view.unmount()
  await Promise.resolve()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
