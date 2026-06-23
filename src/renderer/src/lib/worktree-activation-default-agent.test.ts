import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync'
import { resetWebRuntimeWakeTerminalRespawnForTests } from '@/runtime/web-runtime-wake-terminal-respawn'
import type { Worktree } from '../../../shared/types'

const initialAppStoreState = useAppStore.getState()

function makePlainWorktree(): Worktree {
  return {
    id: 'repo-1::/workspace/feature',
    repoId: 'repo-1',
    path: '/workspace/feature',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    // Why: no createdWithAgent — this worktree was created externally (git
    // worktree add), so the default-agent fallback is the only path that
    // can launch an agent.
    createdWithAgent: undefined
  }
}

function seedEmptyWorktree(worktree: Worktree, settingsOverrides: Record<string, unknown> = {}) {
  const revealWorktreeInSidebar = vi.fn()
  useAppStore.setState({
    repos: [
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { 'repo-1': [worktree] },
    activeRepoId: 'repo-1',
    activeView: 'terminal',
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeTabTypeByWorktree: {},
    activeTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    pendingStartupByTabId: {},
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab',
      ...settingsOverrides
    } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar
  })
  return { revealWorktreeInSidebar }
}

afterEach(() => {
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  vi.unstubAllGlobals()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebRuntimeWakeTerminalRespawnForTests()
  useAppStore.setState(initialAppStoreState, true)
})

describe('activateAndRevealWorktree default agent reopen', () => {
  it('launches the default agent when openWorktreeWithAgent is enabled and no createdWithAgent', () => {
    const worktree = makePlainWorktree()
    seedEmptyWorktree(worktree, {
      openWorktreeWithAgent: true,
      defaultTuiAgent: 'codex',
      disabledTuiAgents: []
    })

    const result = activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[worktree.id]?.[0]

    expect(result).toEqual({ primaryTabId: reopenedTab?.id })
    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toEqual({
      command: "codex '--dangerously-bypass-approvals-and-sandbox'",
      env: {},
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      launchToken: expect.any(String),
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'sidebar',
        request_kind: 'default'
      }
    })
  })

  it('falls back to a plain terminal when openWorktreeWithAgent is disabled', () => {
    const worktree = makePlainWorktree()
    seedEmptyWorktree(worktree, {
      openWorktreeWithAgent: false,
      defaultTuiAgent: 'codex',
      disabledTuiAgents: []
    })

    activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[worktree.id]?.[0]

    expect(reopenedTab).toBeDefined()
    // Why: no launchAgent / startup payload means a plain terminal.
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toBeUndefined()
  })

  it('falls back to a plain terminal when defaultTuiAgent is null (auto)', () => {
    const worktree = makePlainWorktree()
    seedEmptyWorktree(worktree, {
      openWorktreeWithAgent: true,
      defaultTuiAgent: null,
      disabledTuiAgents: []
    })

    activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[worktree.id]?.[0]

    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toBeUndefined()
  })

  it('falls back to a plain terminal when defaultTuiAgent is blank', () => {
    const worktree = makePlainWorktree()
    seedEmptyWorktree(worktree, {
      openWorktreeWithAgent: true,
      defaultTuiAgent: 'blank',
      disabledTuiAgents: []
    })

    activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[worktree.id]?.[0]

    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toBeUndefined()
  })

  it('falls back to a plain terminal when the default agent is disabled', () => {
    const worktree = makePlainWorktree()
    seedEmptyWorktree(worktree, {
      openWorktreeWithAgent: true,
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['codex']
    })

    activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[worktree.id]?.[0]

    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toBeUndefined()
  })

  it('createdWithAgent takes precedence over the default agent', () => {
    // Why: worktree created with gemini, default is codex — should reopen gemini.
    const worktree: Worktree = { ...makePlainWorktree(), createdWithAgent: 'gemini' }
    seedEmptyWorktree(worktree, {
      openWorktreeWithAgent: true,
      defaultTuiAgent: 'codex',
      disabledTuiAgents: []
    })

    activateAndRevealWorktree(worktree.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[worktree.id]?.[0]

    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]?.launchAgent).toBe('gemini')
    expect(state.pendingStartupByTabId[reopenedTab!.id]?.telemetry?.request_kind).toBe('resume')
  })
})
