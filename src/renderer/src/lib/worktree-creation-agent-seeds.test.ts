import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetHookCommandDelayedDeliveryForTests } from './hook-command-delayed-delivery'
import { seedAgentTabStateAfterWorktreeCreate } from './worktree-creation-agent-seeds'

const mocks = vi.hoisted(() => ({
  seedNativeChatAppliedSessionOptions: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn()
}))

vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: mocks.seedNativeChatAppliedSessionOptions
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

type AppState = ReturnType<typeof useAppStore.getState>

const initialTabsByWorktree = useAppStore.getState().tabsByWorktree
const initialGetKnownWorktreeById = useAppStore.getState().getKnownWorktreeById

const DRAFT = 'https://github.com/o/r/issues/12'

const request = {
  agent: 'claude' as const,
  startupPlan: { agent: 'claude', launchCommand: 'claude' } as never,
  launchDraftPrompt: DRAFT
}

function setTabs(tabs: { id: string; launchAgent?: string }[]): void {
  useAppStore.setState({
    tabsByWorktree: { 'wt-1': tabs },
    getKnownWorktreeById: ((id: string) =>
      id === 'wt-1' ? { id } : undefined) as unknown as AppState['getKnownWorktreeById']
  } as unknown as Partial<AppState>)
}

function seededTabIds(): string[] {
  return mocks.seedNativeChatLaunchDraftForAgentTab.mock.calls.map((call) => call[0].tabId)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  resetHookCommandDelayedDeliveryForTests()
  useAppStore.setState({
    tabsByWorktree: initialTabsByWorktree,
    getKnownWorktreeById: initialGetKnownWorktreeById
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
