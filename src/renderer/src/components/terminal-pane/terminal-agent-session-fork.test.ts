import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const mockLaunchAgentInNewTab = vi.fn()
const mockActivateAndRevealWorktree = vi.fn()
const mockCreateWorktree = vi.fn()
const mockToast = {
  error: vi.fn(),
  message: vi.fn(),
  success: vi.fn()
}
const mockWriteClipboardText = vi.fn(async () => undefined)
const mockMarkTrusted = vi.fn(async () => undefined)
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  projects: [] as {
    id: string
    sourceRepoIds: string[]
    localWindowsRuntimePreference?: { kind: 'windows-host' } | { kind: 'wsl'; distro: string }
  }[],
  repos: [] as { id: string; kind?: 'git' | 'folder'; connectionId?: string | null }[],
  settings: {} as {
    localWindowsRuntimeDefault?: { kind: 'windows-host' } | { kind: 'wsl'; distro: string }
  },
  worktreesByRepo: {} as Record<
    string,
    { id: string; repoId: string; path?: string; projectId?: string }[]
  >,
  agentStatusByPaneKey: {} as Record<string, { agentType?: string }>,
  tabsByWorktree: {} as Record<string, { id: string; launchAgent?: string | null }[]>,
  getKnownWorktreeById: vi.fn(),
  createWorktree: mockCreateWorktree
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mockLaunchAgentInNewTab
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mockActivateAndRevealWorktree
}))

vi.mock('sonner', () => ({
  toast: mockToast
}))

function makePane(capturedText: string): ManagedPane {
  return {
    leafId: LEAF_ID,
    serializeAddon: {
      serialize: vi.fn(() => capturedText)
    },
    terminal: {
      focus: vi.fn()
    }
  } as unknown as ManagedPane
}

describe('forkAgentSessionFromPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.activeRepoId = 'repo-1'
    store.activeWorktreeId = 'wt-1'
    store.projects = [
      {
        id: 'repo-1',
        sourceRepoIds: ['repo-1']
      }
    ]
    store.repos = [{ id: 'repo-1', kind: 'git' }]
    store.settings = { localWindowsRuntimeDefault: { kind: 'windows-host' } }
    store.worktreesByRepo = {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: 'C:\\repo', projectId: 'repo-1' }]
    }
    store.agentStatusByPaneKey = {}
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    store.getKnownWorktreeById.mockReturnValue({
      id: 'wt-1',
      repoId: 'repo-1',
      displayName: 'auth-feature',
      branch: 'feature/auth'
    })
    mockCreateWorktree.mockResolvedValue({
      worktree: {
        id: 'wt-fork'
      }
    })
    mockLaunchAgentInNewTab.mockReturnValue({
      tabId: 'tab-2',
      startupPlan: {},
      pasteDraftAfterLaunch: true
    })
    mockWriteClipboardText.mockResolvedValue(undefined)
    mockMarkTrusted.mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: {
        ui: {
          writeClipboardText: mockWriteClipboardText
        },
        agentTrust: {
          markTrusted: mockMarkTrusted
        },
        platform: {
          get: () => ({ platform: 'win32' })
        }
      }
    })
  })

  it('creates a top-level workspace fork with a draft agent tab when the source agent is known', async () => {
    store.agentStatusByPaneKey = {
      [`tab-1:${LEAF_ID}`]: { agentType: 'codex' }
    }
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: compare OAuth options'),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(mockCreateWorktree).toHaveBeenCalledWith(
      'repo-1',
      'auth-feature-fork',
      'feature/auth',
      'inherit',
      undefined,
      'terminal_context_menu',
      'Fork of auth-feature',
      undefined,
      undefined,
      undefined,
      'codex'
    )

    expect(mockLaunchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        worktreeId: 'wt-fork',
        prompt: expect.stringContaining('User: compare OAuth options'),
        promptDelivery: 'draft',
        launchSource: 'terminal_context_menu'
      })
    )
    expect(mockActivateAndRevealWorktree).toHaveBeenCalledWith('wt-fork')
    expect(mockToast.success).toHaveBeenCalledWith(
      'Top-level session fork opened in a new workspace'
    )
  })

  it('pre-marks trust for the created fork workspace before launching a trusted agent', async () => {
    store.agentStatusByPaneKey = {
      [`tab-1:${LEAF_ID}`]: { agentType: 'codex' }
    }
    mockCreateWorktree.mockResolvedValueOnce({
      worktree: {
        id: 'wt-fork',
        path: '/repo/worktrees/auth-feature-fork'
      }
    })
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: compare OAuth options'),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockMarkTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/repo/worktrees/auth-feature-fork'
    })
    expect(mockMarkTrusted.mock.invocationCallOrder[0]).toBeLessThan(
      mockLaunchAgentInNewTab.mock.invocationCallOrder[0]
    )
    expect(mockLaunchAgentInNewTab).toHaveBeenCalled()
  })

  it('uses remote trust and Linux startup quoting for SSH workspaces', async () => {
    store.repos = [{ id: 'repo-1', kind: 'git', connectionId: 'ssh-1' }]
    store.agentStatusByPaneKey = {
      [`tab-1:${LEAF_ID}`]: { agentType: 'codex' }
    }
    mockCreateWorktree.mockResolvedValueOnce({
      worktree: {
        id: 'wt-fork',
        path: '/home/u/repo/auth-feature-fork'
      }
    })
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: compare OAuth options'),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockMarkTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/home/u/repo/auth-feature-fork',
      connectionId: 'ssh-1'
    })
    expect(mockLaunchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        worktreeId: 'wt-fork',
        launchPlatform: 'linux'
      })
    )
  })

  it('uses Linux startup quoting for WSL workspaces', async () => {
    store.agentStatusByPaneKey = {
      [`tab-1:${LEAF_ID}`]: { agentType: 'pi' }
    }
    mockCreateWorktree.mockResolvedValueOnce({
      worktree: {
        id: 'wt-fork',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo\\auth-feature-fork'
      }
    })
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: compare OAuth options'),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockLaunchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'pi',
        worktreeId: 'wt-fork',
        launchPlatform: 'linux'
      })
    )
  })

  it('uses Linux startup quoting when a Windows-path project is forced to WSL', async () => {
    store.projects = [
      {
        id: 'repo-1',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
    ]
    store.agentStatusByPaneKey = {
      [`tab-1:${LEAF_ID}`]: { agentType: 'pi' }
    }
    mockCreateWorktree.mockResolvedValueOnce({
      worktree: {
        id: 'wt-fork',
        path: 'C:\\repo\\auth-feature-fork'
      }
    })
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: compare OAuth options'),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockLaunchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'pi',
        worktreeId: 'wt-fork',
        launchPlatform: 'linux'
      })
    )
  })

  it('still launches the forked agent when trust preflight fails', async () => {
    store.agentStatusByPaneKey = {
      [`tab-1:${LEAF_ID}`]: { agentType: 'codex' }
    }
    mockCreateWorktree.mockResolvedValueOnce({
      worktree: {
        id: 'wt-fork',
        path: '/repo/worktrees/auth-feature-fork'
      }
    })
    mockMarkTrusted.mockRejectedValueOnce(new Error('trust write failed'))
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: continue after trust failure'),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockMarkTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/repo/worktrees/auth-feature-fork'
    })
    expect(mockLaunchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        worktreeId: 'wt-fork',
        prompt: expect.stringContaining('User: continue after trust failure')
      })
    )
    expect(mockToast.error).not.toHaveBeenCalledWith('trust write failed')
  })

  it('creates a top-level workspace fork and copies context when the source agent cannot be resolved', async () => {
    const pane = makePane('Assistant: here is the current plan')
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockCreateWorktree).toHaveBeenCalledWith(
      'repo-1',
      'auth-feature-fork',
      'feature/auth',
      'inherit',
      undefined,
      'terminal_context_menu',
      'Fork of auth-feature',
      undefined,
      undefined,
      undefined,
      undefined
    )
    expect(mockLaunchAgentInNewTab).not.toHaveBeenCalled()
    expect(mockActivateAndRevealWorktree).toHaveBeenCalledWith('wt-fork')
    expect(mockWriteClipboardText).toHaveBeenCalledWith(
      expect.stringContaining('Assistant: here is the current plan')
    )
    expect(mockToast.message).toHaveBeenCalledWith(
      'Fork context copied. Launch an agent and paste it to start the fork.'
    )
    expect(pane.terminal.focus).toHaveBeenCalled()
  })

  it('keeps the fork dialog path open when the source workspace has no git branch', async () => {
    store.getKnownWorktreeById.mockReturnValue({
      id: 'wt-1',
      repoId: 'repo-1',
      displayName: 'scratch',
      branch: ''
    })
    const pane = makePane('User: summarize this scratch plan')
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockCreateWorktree).not.toHaveBeenCalled()
    expect(mockLaunchAgentInNewTab).not.toHaveBeenCalled()
    expect(mockWriteClipboardText).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(
      'This workspace cannot be forked into a git worktree.'
    )
  })

  it.each([
    ['archived', { isArchived: true }],
    ['bare', { isBare: true }]
  ])('does not create a worktree from an %s source workspace', async (_label, override) => {
    store.getKnownWorktreeById.mockReturnValue({
      id: 'wt-1',
      repoId: 'repo-1',
      displayName: 'auth-feature',
      branch: 'feature/auth',
      ...override
    })
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: fork this blocked workspace'),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockCreateWorktree).not.toHaveBeenCalled()
    expect(mockWriteClipboardText).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(
      'This workspace cannot be forked into a git worktree.'
    )
  })

  it('does not create a worktree from a folder-only source workspace', async () => {
    store.repos = [{ id: 'repo-1', kind: 'folder' }]
    store.getKnownWorktreeById.mockReturnValue({
      id: 'wt-1',
      repoId: 'repo-1',
      displayName: 'folder-project',
      branch: 'feature/auth'
    })
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: fork this folder workspace'),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockCreateWorktree).not.toHaveBeenCalled()
    expect(mockWriteClipboardText).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(
      'This workspace cannot be forked into a git worktree.'
    )
  })

  it('does not create a worktree from a floating terminal workspace', async () => {
    store.getKnownWorktreeById.mockReturnValue({
      id: FLOATING_TERMINAL_WORKTREE_ID,
      repoId: 'repo-1',
      displayName: 'Floating',
      branch: 'feature/auth'
    })
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: fork this floating terminal'),
      tabId: 'tab-1',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      groupId: null
    })

    expect(mockCreateWorktree).not.toHaveBeenCalled()
    expect(mockWriteClipboardText).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(
      'This workspace cannot be forked into a git worktree.'
    )
  })

  it('keeps context available when workspace creation fails', async () => {
    mockCreateWorktree.mockRejectedValueOnce(new Error('path already exists'))
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane: makePane('User: carry this context forward'),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockLaunchAgentInNewTab).not.toHaveBeenCalled()
    expect(mockWriteClipboardText).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith('path already exists')
  })

  it('copies context when the detected agent cannot queue a startup plan', async () => {
    store.agentStatusByPaneKey = {
      [`tab-1:${LEAF_ID}`]: { agentType: 'codex' }
    }
    mockLaunchAgentInNewTab.mockReturnValueOnce(null)
    const pane = makePane('Assistant: current implementation notes')
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockCreateWorktree).toHaveBeenCalled()
    expect(mockLaunchAgentInNewTab).toHaveBeenCalled()
    expect(mockWriteClipboardText).toHaveBeenCalledWith(
      expect.stringContaining('Assistant: current implementation notes')
    )
    expect(mockToast.message).toHaveBeenCalledWith(
      'Fork context copied. Launch an agent and paste it to start the fork.'
    )
  })

  it('surfaces clipboard failures instead of closing the fallback path silently', async () => {
    mockWriteClipboardText.mockRejectedValueOnce(new Error('clipboard denied'))
    const pane = makePane('Assistant: copy fallback context')
    const { forkAgentSessionFromPane } = await import('./terminal-agent-session-fork')

    await forkAgentSessionFromPane({
      pane,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null
    })

    expect(mockLaunchAgentInNewTab).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith('clipboard denied')
    expect(pane.terminal.focus).toHaveBeenCalled()
  })
})

describe('copyAgentSessionContextFromPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteClipboardText.mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: { ui: { writeClipboardText: mockWriteClipboardText } }
    })
  })

  it('copies the bounded transcript without the fork prompt framing', async () => {
    const pane = makePane('User: standalone copy\nAssistant: acknowledged')
    const { copyAgentSessionContextFromPane } = await import('./terminal-agent-session-fork')

    const copied = await copyAgentSessionContextFromPane(pane)

    expect(copied).toBe(true)
    expect(mockWriteClipboardText).toHaveBeenCalledTimes(1)
    const clipped = (mockWriteClipboardText.mock.calls as unknown as string[][])[0][0]
    expect(clipped).toContain('User: standalone copy')
    // Why: standalone copy must not carry the fork header/footer the dialog adds.
    expect(clipped).not.toContain('fork of an existing Orca agent session')
    expect(clipped).not.toContain('wait for my next instruction')
    expect(mockToast.message).toHaveBeenCalledWith('Context copied')
    expect(mockToast.message).not.toHaveBeenCalledWith(
      'Fork context copied. Launch an agent and paste it to start the fork.'
    )
    expect(pane.terminal.focus).toHaveBeenCalled()
  })

  it('shows a copy-specific empty-context error without writing the clipboard', async () => {
    const pane = makePane('\x1b[0m\r\n\x1bc\x07')
    const { copyAgentSessionContextFromPane } = await import('./terminal-agent-session-fork')

    const copied = await copyAgentSessionContextFromPane(pane)

    expect(copied).toBe(false)
    expect(mockWriteClipboardText).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith('No terminal context to copy')
    expect(pane.terminal.focus).toHaveBeenCalled()
  })

  it('surfaces clipboard write failures', async () => {
    mockWriteClipboardText.mockRejectedValueOnce(new Error('clipboard denied'))
    const pane = makePane('User: copy this')
    const { copyAgentSessionContextFromPane } = await import('./terminal-agent-session-fork')

    const copied = await copyAgentSessionContextFromPane(pane)

    expect(copied).toBe(false)
    expect(mockToast.error).toHaveBeenCalledWith('clipboard denied')
    expect(pane.terminal.focus).toHaveBeenCalled()
  })
})
