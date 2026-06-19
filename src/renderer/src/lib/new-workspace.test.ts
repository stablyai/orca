import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockInspectRuntimeTerminalProcess,
  mockSendRuntimePtyInputVerified,
  mockPasteDraftWhenAgentReady,
  mockTrack,
  store
} = vi.hoisted(() => ({
  mockInspectRuntimeTerminalProcess: vi.fn(),
  mockSendRuntimePtyInputVerified: vi.fn(),
  mockPasteDraftWhenAgentReady: vi.fn(),
  mockTrack: vi.fn(),
  store: {
    settings: {},
    activeTabIdByWorktree: { 'wt-1': 'tab-1' } as Record<string, string>,
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } as Record<string, { id: string }[]>,
    ptyIdsByTabId: { 'tab-1': ['pty-1'] } as Record<string, string[]>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: mockInspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified: mockSendRuntimePtyInputVerified
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/telemetry', () => ({
  track: mockTrack
}))

import {
  ensureAgentStartupInTerminal,
  getSetupConfig,
  getWorkspaceSeedName,
  isGitLabIssueUrl
} from './new-workspace'

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

  it('does not classify GitHub issue URLs as GitLab issues', () => {
    expect(isGitLabIssueUrl('https://github.com/group/project/issues/123')).toBe(false)
  })
})

describe('ensureAgentStartupInTerminal prompt delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = {}
    store.activeTabIdByWorktree = { 'wt-1': 'tab-1' }
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    store.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    mockInspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'aider',
      hasChildProcesses: true
    })
    mockSendRuntimePtyInputVerified.mockResolvedValue(true)
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  })

  it('sends a follow-up prompt through the terminal runtime without renderer telemetry', async () => {
    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      startup: {
        agent: 'aider',
        launchCommand: 'aider',
        expectedProcess: 'aider',
        followupPrompt: 'fix the spinner'
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
        followupPrompt: 'fix the spinner'
      }
    })

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
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
          followupPrompt: 'fix the spinner'
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
        draftPrompt: 'review this before sending'
      }
    })

    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith({
      tabId: 'tab-1',
      content: 'review this before sending',
      agent: 'claude'
    })
    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('pastes drafts into the activation primary tab when active tab state differs', async () => {
    store.activeTabIdByWorktree = { 'wt-1': 'setup-tab' }
    store.tabsByWorktree = { 'wt-1': [{ id: 'setup-tab' }, { id: 'agent-tab' }] }
    store.ptyIdsByTabId = { 'setup-tab': ['setup-pty'], 'agent-tab': ['agent-pty'] }

    await ensureAgentStartupInTerminal({
      worktreeId: 'wt-1',
      primaryTabId: 'agent-tab',
      startup: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        draftPrompt: 'Linear context draft'
      }
    })

    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith({
      tabId: 'agent-tab',
      content: 'Linear context draft',
      agent: 'codex'
    })
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
