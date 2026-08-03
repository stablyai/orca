import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetHookCommandDelayedDeliveryForTests } from './hook-command-delayed-delivery'
import { seedAgentTabStateAfterWorktreeCreate } from './worktree-creation-agent-seeds'

const mocks = vi.hoisted(() => ({
  seedNativeChatAppliedSessionOptions: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  setWebRuntimeTabProps: vi.fn()
}))

vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: mocks.seedNativeChatAppliedSessionOptions
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  setWebRuntimeTabProps: mocks.setWebRuntimeTabProps
}))

type AppState = ReturnType<typeof useAppStore.getState>

const initialTabsByWorktree = useAppStore.getState().tabsByWorktree
const initialUnifiedTabsByWorktree = useAppStore.getState().unifiedTabsByWorktree
const initialGetKnownWorktreeById = useAppStore.getState().getKnownWorktreeById
const initialSettings = useAppStore.getState().settings!
const initialWorktreesByRepo = useAppStore.getState().worktreesByRepo
const initialRepos = useAppStore.getState().repos

const DRAFT = 'https://github.com/o/r/issues/12'

const request = {
  agent: 'claude' as const,
  startupPlan: { agent: 'claude', launchCommand: 'claude' } as never,
  launchDraftPrompt: DRAFT
}

function setTabs(
  tabs: { id: string; launchAgent?: string; viewMode?: 'terminal' | 'chat' }[],
  runtimeOwnerEnvironmentId?: string
): void {
  useAppStore.setState({
    tabsByWorktree: { 'wt-1': tabs },
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          path: '/repo/wt-1',
          ...(runtimeOwnerEnvironmentId ? { runtimeOwnerEnvironmentId } : {})
        }
      ]
    },
    repos: [{ id: 'repo-1', path: '/repo', connectionId: null }],
    unifiedTabsByWorktree: {
      'wt-1': tabs.map((tab, index) => ({
        id: tab.id,
        entityId: tab.id,
        groupId: 'group-1',
        worktreeId: 'wt-1',
        contentType: 'terminal' as const,
        label: `Terminal ${index + 1}`,
        customLabel: null,
        color: null,
        sortOrder: index,
        createdAt: index,
        isPreview: false,
        isPinned: false,
        ...(tab.viewMode ? { viewMode: tab.viewMode } : {})
      }))
    },
    getKnownWorktreeById: ((id: string) =>
      id === 'wt-1' ? { id } : undefined) as unknown as AppState['getKnownWorktreeById']
  } as unknown as Partial<AppState>)
}

function seededTabIds(): string[] {
  return mocks.seedNativeChatLaunchDraftForAgentTab.mock.calls.map((call) => call[0].tabId)
}

function tabViewMode(tabId: string): 'terminal' | 'chat' | undefined {
  return useAppStore.getState().unifiedTabsByWorktree['wt-1']?.find((tab) => tab.id === tabId)
    ?.viewMode
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    settings: {
      ...initialSettings,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
  })
})

afterEach(() => {
  resetHookCommandDelayedDeliveryForTests()
  useAppStore.setState({
    tabsByWorktree: initialTabsByWorktree,
    unifiedTabsByWorktree: initialUnifiedTabsByWorktree,
    getKnownWorktreeById: initialGetKnownWorktreeById,
    settings: initialSettings,
    worktreesByRepo: initialWorktreesByRepo,
    repos: initialRepos
  } as Partial<AppState>)
})

describe('seedAgentTabStateAfterWorktreeCreate', () => {
  it('seeds the backend-spawned startup tab, not the first default terminal tab', () => {
    // Repo default tabs (dev server / logs / shell) run no agent; on the
    // backend-spawn path none of them carries launchAgent either.
    setTabs([{ id: 'dev-server' }, { id: 'logs' }, { id: 'agent-tab' }])

    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: 'wt-1',
      primaryTabId: 'dev-server',
      startupTerminalTabId: 'agent-tab',
      backendSpawned: true
    })

    expect(seededTabIds()).toEqual(['agent-tab'])
    expect(mocks.seedNativeChatAppliedSessionOptions).toHaveBeenCalledWith(
      'agent-tab',
      'claude',
      undefined
    )
  })

  it('moves a backend-spawned non-mirrorable draft out of an inherited chat view', () => {
    setTabs([{ id: 'agent-tab', launchAgent: 'claude', viewMode: 'chat' }])

    seedAgentTabStateAfterWorktreeCreate({
      request: { ...request, launchDraftPrompt: 'note\u2028https://github.com/o/r/issues/12' },
      worktreeId: 'wt-1',
      primaryTabId: 'agent-tab',
      startupTerminalTabId: 'agent-tab',
      backendSpawned: true
    })

    expect(tabViewMode('agent-tab')).toBe('terminal')
  })

  it('opens a backend-spawned mirrorable draft in chat after host reconciliation', () => {
    setTabs([{ id: 'agent-tab', launchAgent: 'claude', viewMode: 'terminal' }])

    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: 'wt-1',
      primaryTabId: 'agent-tab',
      startupTerminalTabId: 'agent-tab',
      backendSpawned: true
    })

    expect(tabViewMode('agent-tab')).toBe('chat')
  })

  it('keys a raw backend tab id and updates the host before its tab mirror lands', async () => {
    setTabs([], 'runtime-1')

    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: 'wt-1',
      primaryTabId: null,
      startupTerminalTabId: 'host-agent-tab',
      backendSpawned: true
    })

    expect(seededTabIds()).toEqual(['web-terminal-host-agent-tab'])
    await vi.waitFor(() =>
      expect(mocks.setWebRuntimeTabProps).toHaveBeenCalledWith({
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-agent-tab',
        viewMode: 'chat'
      })
    )
    setTabs(
      [{ id: 'web-terminal-host-agent-tab', launchAgent: 'claude', viewMode: 'chat' }],
      'runtime-1'
    )
    expect(seededTabIds()).toEqual(['web-terminal-host-agent-tab'])
  })

  it('seeds the launchAgent-stamped tab when the renderer owns startup', () => {
    setTabs([{ id: 'dev-server' }, { id: 'agent-tab', launchAgent: 'claude' }])

    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: 'wt-1',
      primaryTabId: 'dev-server',
      startupTerminalTabId: undefined,
      backendSpawned: false
    })

    expect(seededTabIds()).toEqual(['agent-tab'])
  })

  it('still seeds primaryTabId on the ordinary local path', () => {
    setTabs([{ id: 'tab-1' }])

    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: 'wt-1',
      primaryTabId: 'tab-1',
      startupTerminalTabId: undefined,
      backendSpawned: false
    })

    expect(seededTabIds()).toEqual(['tab-1'])
  })

  it('never falls back to an unrelated first tab', () => {
    setTabs([{ id: 'dev-server' }, { id: 'logs' }])

    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: 'wt-1',
      primaryTabId: null,
      startupTerminalTabId: undefined,
      backendSpawned: false
    })

    expect(mocks.seedNativeChatLaunchDraftForAgentTab).not.toHaveBeenCalled()
  })

  it('defers the seed to the first mirrored tab on runtime-owned worktrees', () => {
    // Runtime-owned (web session) worktrees mirror their session tabs async, so
    // the worktree has no tab at all at seed time.
    setTabs([])

    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: 'wt-1',
      primaryTabId: null,
      startupTerminalTabId: undefined,
      backendSpawned: false
    })
    expect(mocks.seedNativeChatLaunchDraftForAgentTab).not.toHaveBeenCalled()

    setTabs([{ id: 'mirror-tab-1' }])

    expect(seededTabIds()).toEqual(['mirror-tab-1'])
    expect(mocks.seedNativeChatAppliedSessionOptions).toHaveBeenCalledWith(
      'mirror-tab-1',
      'claude',
      undefined
    )
  })

  it('prefers the agent-stamped tab over the first mirrored tab when both land', () => {
    setTabs([])

    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: 'wt-1',
      primaryTabId: null,
      startupTerminalTabId: undefined,
      backendSpawned: false
    })

    setTabs([{ id: 'mirror-shell' }, { id: 'mirror-agent', launchAgent: 'claude' }])

    expect(seededTabIds()).toEqual(['mirror-agent'])
  })

  it('drops the deferred seed when the mirrored tabs are ambiguous', () => {
    // Repo default tabs mirror together and none is stamped: `tabs[0]` here is
    // "dev server". Seeding it would be withheld from mobile by the agent check
    // and ignored on desktop — the same invariant the synchronous path holds.
    setTabs([])

    seedAgentTabStateAfterWorktreeCreate({
      request,
      worktreeId: 'wt-1',
      primaryTabId: null,
      startupTerminalTabId: undefined,
      backendSpawned: false
    })

    setTabs([{ id: 'mirror-dev-server' }, { id: 'mirror-logs' }])

    expect(mocks.seedNativeChatLaunchDraftForAgentTab).not.toHaveBeenCalled()
    expect(mocks.seedNativeChatAppliedSessionOptions).not.toHaveBeenCalled()
  })

  it('seeds session options but no draft without launch draft context', () => {
    setTabs([{ id: 'tab-1' }])

    seedAgentTabStateAfterWorktreeCreate({
      request: { agent: 'claude', startupPlan: request.startupPlan },
      worktreeId: 'wt-1',
      primaryTabId: 'tab-1',
      startupTerminalTabId: undefined,
      backendSpawned: false
    })

    expect(mocks.seedNativeChatAppliedSessionOptions).toHaveBeenCalledOnce()
    expect(mocks.seedNativeChatLaunchDraftForAgentTab).not.toHaveBeenCalled()
  })

  it('does nothing without an agent or a startup plan', () => {
    setTabs([{ id: 'tab-1' }])

    seedAgentTabStateAfterWorktreeCreate({
      request: { agent: null, startupPlan: request.startupPlan, launchDraftPrompt: DRAFT },
      worktreeId: 'wt-1',
      primaryTabId: 'tab-1',
      startupTerminalTabId: undefined,
      backendSpawned: false
    })
    seedAgentTabStateAfterWorktreeCreate({
      request: { agent: 'claude', startupPlan: null, launchDraftPrompt: DRAFT },
      worktreeId: 'wt-1',
      primaryTabId: 'tab-1',
      startupTerminalTabId: undefined,
      backendSpawned: false
    })

    expect(mocks.seedNativeChatAppliedSessionOptions).not.toHaveBeenCalled()
    expect(mocks.seedNativeChatLaunchDraftForAgentTab).not.toHaveBeenCalled()
  })
})
