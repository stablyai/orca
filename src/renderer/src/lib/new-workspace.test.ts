import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockInspectRuntimeTerminalProcess,
  mockPasteDraftToAgentPtyWhenReady,
  mockShowAutomationPromptNotSentToast,
  mockTrack,
  store,
  storeListeners,
  startupLeafId
} = vi.hoisted(() => ({
  mockInspectRuntimeTerminalProcess: vi.fn(),
  mockPasteDraftToAgentPtyWhenReady: vi.fn(),
  mockShowAutomationPromptNotSentToast: vi.fn(),
  mockTrack: vi.fn(),
  storeListeners: new Set<(state: unknown, previousState: unknown) => void>(),
  startupLeafId: '11111111-1111-4111-8111-111111111111',
  store: {
    settings: {},
    activeTabIdByWorktree: { 'wt-1': 'tab-1' } as Record<string, string>,
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } as Record<string, { id: string }[]>,
    ptyIdsByTabId: { 'tab-1': ['pty-1'] } as Record<string, string[]>,
    pendingStartupByTabId: {} as Record<string, { launchToken?: string }>,
    terminalLayoutsByTabId: {
      'tab-1': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': 'pty-1' }
      }
    } as Record<
      string,
      {
        root: null
        activeLeafId: null
        expandedLeafId: null
        ptyIdsByLeafId?: Record<string, string>
      }
    >,
    agentLaunchConfigByPaneKey: {
      'tab-1:11111111-1111-4111-8111-111111111111': {
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        registeredAt: 1,
        identity: {
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111',
          launchToken: 'launch-token-1'
        }
      }
    } as Record<
      string,
      {
        launchConfig: { agentCommand: string; agentArgs: string; agentEnv: Record<string, string> }
        registeredAt: number
        identity: { tabId?: string; leafId?: string; launchToken?: string }
      }
    >
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store,
    subscribe: (listener: (state: unknown, previousState: unknown) => void) => {
      storeListeners.add(listener)
      return () => {
        storeListeners.delete(listener)
      }
    }
  }
}))

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: mockInspectRuntimeTerminalProcess
}))

vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({
  pasteDraftToAgentPtyWhenReady: mockPasteDraftToAgentPtyWhenReady
}))

const mockLaunchUuid = vi.hoisted(() => () => 'launch-token-1')
vi.mock('../../../shared/non-secure-context-uuid', () => ({
  createNonSecureContextUuid: mockLaunchUuid
}))

vi.mock('@/lib/telemetry', () => ({
  track: mockTrack
}))

vi.mock('@/lib/agent-session/launch/background/agent-background-session-timeout-toast', () => ({
  showAutomationPromptNotSentToast: mockShowAutomationPromptNotSentToast
}))

import { ensureAgentStartupInTerminal } from './new-workspace'
import { resetAgentStartupDelayedDeliveryForTests } from './agent-session/launch/startup/agent-startup-delayed-delivery'

describe('ensureAgentStartupInTerminal prompt delivery', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    storeListeners.clear()
    store.settings = {}
    store.activeTabIdByWorktree = { 'wt-1': 'tab-1' }
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    store.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    store.pendingStartupByTabId = {}
    store.terminalLayoutsByTabId = {
      'tab-1': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { [startupLeafId]: 'pty-1' }
      }
    }
    store.agentLaunchConfigByPaneKey = {
      [`tab-1:${startupLeafId}`]: {
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        registeredAt: 1,
        identity: { tabId: 'tab-1', leafId: startupLeafId, launchToken: 'launch-token-1' }
      }
    }
    mockInspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'aider',
      hasChildProcesses: true
    })
    mockPasteDraftToAgentPtyWhenReady.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    resetAgentStartupDelayedDeliveryForTests()
  })

  it('keeps waiting when a non-startup split PTY appears before the startup PTY', async () => {
    vi.useFakeTimers()
    store.ptyIdsByTabId = {}
    store.terminalLayoutsByTabId = {}
    store.agentLaunchConfigByPaneKey = {}
    store.pendingStartupByTabId = { 'tab-1': { launchToken: 'launch-token-1' } }

    const delivery = ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      primaryTabId: 'tab-1',
      startup: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentArgs: '', agentEnv: {} },
        draftPrompt: 'linked draft'
      }
    })

    await vi.advanceTimersByTimeAsync(5_000)
    await delivery

    const splitLeafId = '22222222-2222-4222-8222-222222222222'
    store.ptyIdsByTabId = { 'tab-1': ['split-pty'] }
    store.terminalLayoutsByTabId = {
      'tab-1': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { [splitLeafId]: 'split-pty' }
      }
    }
    store.agentLaunchConfigByPaneKey = {
      [`tab-1:${splitLeafId}`]: {
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        registeredAt: 1,
        identity: { tabId: 'tab-1', leafId: splitLeafId, launchToken: 'other-token' }
      }
    }
    for (const listener of storeListeners) {
      listener(store, store)
    }

    expect(mockPasteDraftToAgentPtyWhenReady).not.toHaveBeenCalled()

    store.ptyIdsByTabId = { 'tab-1': ['split-pty', 'startup-pty'] }
    store.terminalLayoutsByTabId = {
      'tab-1': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { [splitLeafId]: 'split-pty', [startupLeafId]: 'startup-pty' }
      }
    }
    store.agentLaunchConfigByPaneKey = {
      [`tab-1:${splitLeafId}`]: {
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        registeredAt: 1,
        identity: { tabId: 'tab-1', leafId: splitLeafId, launchToken: 'other-token' }
      },
      [`tab-1:${startupLeafId}`]: {
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        registeredAt: 2,
        identity: { tabId: 'tab-1', leafId: startupLeafId, launchToken: 'launch-token-1' }
      }
    }
    for (const listener of storeListeners) {
      listener(store, store)
    }

    expect(mockPasteDraftToAgentPtyWhenReady).toHaveBeenCalledTimes(1)
    expect(mockPasteDraftToAgentPtyWhenReady).toHaveBeenCalledWith({
      ptyId: 'startup-pty',
      content: 'linked draft',
      agent: 'codex',
      forcePaste: true,
      onTimeout: expect.any(Function)
    })
  })

  it('keeps one delayed subscription and tears it down after delivery drains', async () => {
    vi.useFakeTimers()
    store.ptyIdsByTabId = {}
    store.terminalLayoutsByTabId = {}
    store.agentLaunchConfigByPaneKey = {}
    store.pendingStartupByTabId = { 'tab-1': { launchToken: 'launch-token-1' } }
    const startup = {
      agent: 'codex' as const,
      launchCommand: 'codex',
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} },
      draftPrompt: 'linked draft',
      launchToken: 'launch-token-1'
    }

    const first = ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      primaryTabId: 'tab-1',
      startup
    })
    const second = ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      primaryTabId: 'tab-1',
      startup
    })

    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all([first, second])

    expect(storeListeners.size).toBe(1)

    store.ptyIdsByTabId = { 'tab-1': ['pty-delayed'] }
    store.pendingStartupByTabId = {}
    store.terminalLayoutsByTabId = {
      'tab-1': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { [startupLeafId]: 'pty-delayed' }
      }
    }
    store.agentLaunchConfigByPaneKey = {
      [`tab-1:${startupLeafId}`]: {
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        registeredAt: 1,
        identity: { tabId: 'tab-1', leafId: startupLeafId, launchToken: 'launch-token-1' }
      }
    }
    for (const listener of storeListeners) {
      listener(store, store)
    }

    expect(mockPasteDraftToAgentPtyWhenReady).toHaveBeenCalledTimes(1)
    expect(storeListeners.size).toBe(0)
  })

  it('does not let a newer same-tab launch satisfy an older pending delivery', async () => {
    vi.useFakeTimers()
    store.ptyIdsByTabId = {}
    store.terminalLayoutsByTabId = {}
    store.agentLaunchConfigByPaneKey = {}
    store.pendingStartupByTabId = { 'tab-1': { launchToken: 'launch-token-old' } }

    const delivery = ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      primaryTabId: 'tab-1',
      startup: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentArgs: '', agentEnv: {} },
        draftPrompt: 'old linked draft',
        launchToken: 'launch-token-old'
      }
    })

    await vi.advanceTimersByTimeAsync(5_000)
    await delivery

    store.pendingStartupByTabId = { 'tab-1': { launchToken: 'launch-token-new' } }
    for (const listener of storeListeners) {
      listener(store, store)
    }

    store.ptyIdsByTabId = { 'tab-1': ['pty-new'] }
    store.pendingStartupByTabId = {}
    store.terminalLayoutsByTabId = {
      'tab-1': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { [startupLeafId]: 'pty-new' }
      }
    }
    store.agentLaunchConfigByPaneKey = {
      [`tab-1:${startupLeafId}`]: {
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        registeredAt: 1,
        identity: { tabId: 'tab-1', leafId: startupLeafId, launchToken: 'launch-token-old' }
      }
    }
    for (const listener of storeListeners) {
      listener(store, store)
    }

    expect(mockPasteDraftToAgentPtyWhenReady).not.toHaveBeenCalled()
  })
})
