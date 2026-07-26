import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockInspectRuntimeTerminalProcess,
  mockSendRuntimePtyInputVerified,
  mockPasteDraftToAgentPtyWhenReady,
  mockShowAutomationPromptNotSentToast,
  mockTrack,
  store,
  storeListeners,
  startupLeafId
} = vi.hoisted(() => ({
  mockInspectRuntimeTerminalProcess: vi.fn(),
  mockSendRuntimePtyInputVerified: vi.fn(),
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

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: mockInspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified: mockSendRuntimePtyInputVerified
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: () => store.settings,
  pasteDraftToAgentPtyWhenReady: mockPasteDraftToAgentPtyWhenReady
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'launch-token-1'
}))

vi.mock('@/lib/telemetry', () => ({
  track: mockTrack
}))

vi.mock('@/lib/agent-background-session-timeout-toast', () => ({
  showAutomationPromptNotSentToast: mockShowAutomationPromptNotSentToast
}))

import {
  ensureAgentStartupInTerminal,
  getSetupConfig,
  getWorkspaceSeedName,
  isGitLabIssueUrl
} from './new-workspace'
import { resetAgentStartupDelayedDeliveryForTests } from './agent-startup-delayed-delivery'

describe('getWorkspaceSeedName', () => {
  it('prefers an explicit name', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: 'my-workspace',
        prompt: 'anything',
        linkedIssueNumber: null,
        linkedPR: null
      })
    ).toBe('my-workspace')
  })

  it('uses linked issue/PR when no explicit name is provided', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '',
        linkedIssueNumber: 7,
        linkedPR: null
      })
    ).toBe('issue-7')
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '',
        linkedIssueNumber: null,
        linkedPR: 42
      })
    ).toBe('pr-42')
  })

  it('slugifies and truncates very long prompts', () => {
    const longPrompt =
      'Investigate the flaky login regression on iOS where the session cookie is dropped after background refresh and users get bounced to the splash screen.'
    const seed = getWorkspaceSeedName({
      explicitName: '',
      prompt: longPrompt,
      linkedIssueNumber: null,
      linkedPR: null
    })
    expect(seed.length).toBeLessThanOrEqual(48)
    expect(seed).toMatch(/^[a-z0-9._-]+$/)
    expect(seed.startsWith('investigate-the-flaky-login')).toBe(true)
  })

  it('falls back to "workspace" when a prompt has no sluggable characters', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '🚀🚀🚀',
        linkedIssueNumber: null,
        linkedPR: null
      })
    ).toBe('workspace')
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '日本語だけ',
        linkedIssueNumber: null,
        linkedPR: null
      })
    ).toBe('workspace')
  })

  it('does not leave internal ".." in the slug (git refuses such branches)', () => {
    // Why: the original composer bug — a prompt containing "../../" in
    // relative path references slugified to a name with internal `..`,
    // which git rejects with "is not a valid branch name".
    const seed = getWorkspaceSeedName({
      explicitName: '',
      prompt: 'For ../../ the sibling worktree from another repo',
      linkedIssueNumber: null,
      linkedPR: null
    })
    expect(seed).not.toMatch(/\.{2,}/)
  })

  it('falls back to "workspace" for empty inputs', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '',
        linkedIssueNumber: null,
        linkedPR: null
      })
    ).toBe('workspace')
  })

  it('uses the fallback name when no other seed source is available', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: '',
        prompt: '',
        linkedIssueNumber: null,
        linkedPR: null,
        fallbackName: 'Nautilus'
      })
    ).toBe('Nautilus')
  })

  it('prefers an explicit name over the fallback name', () => {
    expect(
      getWorkspaceSeedName({
        explicitName: 'my-workspace',
        prompt: '',
        linkedIssueNumber: null,
        linkedPR: null,
        fallbackName: 'Nautilus'
      })
    ).toBe('my-workspace')
  })
})

describe('isGitLabIssueUrl', () => {
  it('detects canonical and self-hosted GitLab issue URLs', () => {
    expect(isGitLabIssueUrl('https://gitlab.com/group/project/-/issues/123')).toBe(true)
    expect(isGitLabIssueUrl('https://gitlab.example.com/group/project/-/issues/123')).toBe(true)
  })

  it('detects modern /-/work_items/<iid> issue URLs (incl. non-default port)', () => {
    expect(isGitLabIssueUrl('https://gitlab.com/group/project/-/work_items/123')).toBe(true)
    expect(isGitLabIssueUrl('https://gitlab.example.com:8443/group/project/-/work_items/7')).toBe(
      true
    )
  })

  it('does not classify GitHub issue URLs as GitLab issues', () => {
    expect(isGitLabIssueUrl('https://github.com/group/project/issues/123')).toBe(false)
  })
})

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
    mockSendRuntimePtyInputVerified.mockResolvedValue(true)
    mockPasteDraftToAgentPtyWhenReady.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    resetAgentStartupDelayedDeliveryForTests()
  })

  it('sends a follow-up prompt through the terminal runtime without renderer telemetry', async () => {
    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      startup: {
        agent: 'aider',
        launchCommand: 'aider',
        expectedProcess: 'aider',
        followupPrompt: 'fix the spinner',
        launchConfig: { agentArgs: '', agentEnv: {} }
      }
    })

    expect(mockSendRuntimePtyInputVerified).toHaveBeenCalledWith({}, 'pty-1', 'fix the spinner\r')
    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('does not track when follow-up prompt delivery is rejected by the terminal runtime', async () => {
    mockSendRuntimePtyInputVerified.mockResolvedValue(false)

    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      startup: {
        agent: 'aider',
        launchCommand: 'aider',
        expectedProcess: 'aider',
        followupPrompt: 'fix the spinner',
        launchConfig: { agentArgs: '', agentEnv: {} }
      }
    })

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('surfaces the not-sent toast when a follow-up prompt is dropped', async () => {
    // Foreground never becomes a recognized agent and there is no live child,
    // so the readiness wait times out and the prompt is not delivered.
    mockInspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })

    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      startup: {
        agent: 'aider',
        launchCommand: 'aider',
        expectedProcess: 'aider',
        followupPrompt: 'fix the spinner',
        launchConfig: { agentArgs: '', agentEnv: {} }
      }
    })

    expect(mockSendRuntimePtyInputVerified).not.toHaveBeenCalled()
    expect(mockShowAutomationPromptNotSentToast).toHaveBeenCalledWith('aider')
  })

  it('does not toast when a follow-up prompt is delivered', async () => {
    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      startup: {
        agent: 'aider',
        launchCommand: 'aider',
        expectedProcess: 'aider',
        followupPrompt: 'fix the spinner',
        launchConfig: { agentArgs: '', agentEnv: {} }
      }
    })

    expect(mockShowAutomationPromptNotSentToast).not.toHaveBeenCalled()
  })

  it('passes an onTimeout that surfaces the not-sent toast to the draft paste path', async () => {
    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      startup: {
        agent: 'claude',
        launchCommand: 'claude',
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: { agentArgs: '', agentEnv: {} },
        draftPrompt: 'review this before sending'
      }
    })

    const call = mockPasteDraftToAgentPtyWhenReady.mock.calls.at(-1)?.[0] as
      | { onTimeout?: () => void }
      | undefined
    expect(call?.onTimeout).toBeTypeOf('function')
    call?.onTimeout?.()
    expect(mockShowAutomationPromptNotSentToast).toHaveBeenCalledWith('claude')
  })

  it('does not track when follow-up prompt delivery rejects', async () => {
    mockSendRuntimePtyInputVerified.mockRejectedValue(new Error('runtime timeout'))

    await expect(
      ensureAgentStartupInTerminal({
        worktreeId: 'wt-1',
        startup: {
          agent: 'aider',
          launchCommand: 'aider',
          expectedProcess: 'aider',
          followupPrompt: 'fix the spinner',
          launchConfig: { agentArgs: '', agentEnv: {} }
        }
      })
    ).resolves.toBeUndefined()

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('does not track draft prompt delivery as a sent prompt', async () => {
    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      startup: {
        agent: 'claude',
        launchCommand: 'claude',
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: { agentArgs: '', agentEnv: {} },
        draftPrompt: 'review this before sending'
      }
    })

    expect(mockPasteDraftToAgentPtyWhenReady).toHaveBeenCalledWith({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      content: 'review this before sending',
      agent: 'claude',
      forcePaste: true,
      onTimeout: expect.any(Function)
    })
    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('pastes drafts into the activation primary tab when active tab state differs', async () => {
    store.activeTabIdByWorktree = { 'wt-1': 'setup-tab' }
    store.tabsByWorktree = { 'wt-1': [{ id: 'setup-tab' }, { id: 'agent-tab' }] }
    store.ptyIdsByTabId = { 'setup-tab': ['setup-pty'], 'agent-tab': ['agent-pty'] }
    store.terminalLayoutsByTabId = {
      'agent-tab': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { [startupLeafId]: 'agent-pty' }
      }
    }
    store.agentLaunchConfigByPaneKey = {
      [`agent-tab:${startupLeafId}`]: {
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        registeredAt: 1,
        identity: { tabId: 'agent-tab', leafId: startupLeafId, launchToken: 'launch-token-1' }
      }
    }

    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      primaryTabId: 'agent-tab',
      startup: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentArgs: '', agentEnv: {} },
        draftPrompt: 'Linear context draft'
      }
    })

    expect(mockPasteDraftToAgentPtyWhenReady).toHaveBeenCalledWith({
      tabId: 'agent-tab',
      ptyId: 'agent-pty',
      content: 'Linear context draft',
      agent: 'codex',
      forcePaste: true,
      onTimeout: expect.any(Function)
    })
  })

  it('pastes a draft after the seeded tab receives a delayed PTY', async () => {
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
        draftPrompt: 'https://github.com/stablyai/orca/pull/2051'
      }
    })

    await vi.advanceTimersByTimeAsync(5_000)
    await delivery

    expect(mockPasteDraftToAgentPtyWhenReady).not.toHaveBeenCalled()

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
    expect(mockPasteDraftToAgentPtyWhenReady).toHaveBeenCalledWith({
      tabId: 'tab-1',
      ptyId: 'pty-delayed',
      content: 'https://github.com/stablyai/orca/pull/2051',
      agent: 'codex',
      forcePaste: true,
      onTimeout: expect.any(Function)
    })
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
      tabId: 'tab-1',
      ptyId: 'startup-pty',
      content: 'linked draft',
      agent: 'codex',
      forcePaste: true,
      onTimeout: expect.any(Function)
    })
  })

  it('does not duplicate delayed delivery across repeated store updates', async () => {
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
      listener(store, store)
    }

    expect(mockPasteDraftToAgentPtyWhenReady).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate immediate delivery for the same launch token', async () => {
    const startup = {
      agent: 'codex' as const,
      launchCommand: 'codex',
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} },
      draftPrompt: 'linked draft',
      launchToken: 'launch-token-1'
    }

    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      primaryTabId: 'tab-1',
      startup
    })
    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      primaryTabId: 'tab-1',
      startup
    })

    expect(mockPasteDraftToAgentPtyWhenReady).toHaveBeenCalledTimes(1)
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

  it('does not write a delayed follow-up prompt on readiness timeout', async () => {
    vi.useFakeTimers()
    mockInspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })

    const delivery = ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      startup: {
        agent: 'aider',
        launchCommand: 'aider',
        expectedProcess: 'aider',
        followupPrompt: 'fix the spinner',
        launchConfig: { agentArgs: '', agentEnv: {} }
      }
    })

    await vi.advanceTimersByTimeAsync(5_000)
    await delivery

    expect(mockSendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })
})

describe('getSetupConfig', () => {
  it('treats default tab commands as setup-decision commands', () => {
    expect(
      getSetupConfig(undefined, {
        scripts: {},
        defaultTabs: [
          { title: 'Server', command: 'pnpm dev' },
          { title: 'Notes' },
          { command: 'codex' }
        ]
      })
    ).toEqual({
      source: 'yaml',
      kind: 'default-tabs',
      command: '# defaultTabs[1] Server\npnpm dev\n\n# defaultTabs[3]\ncodex'
    })
  })

  it('ignores shared default tab commands when command source is local-only', () => {
    expect(
      getSetupConfig(
        {
          hookSettings: {
            commandSourcePolicy: 'local-only',
            scripts: {}
          }
        },
        {
          scripts: {},
          defaultTabs: [{ title: 'Server', command: 'pnpm dev' }]
        }
      )
    ).toBeNull()
  })
})
