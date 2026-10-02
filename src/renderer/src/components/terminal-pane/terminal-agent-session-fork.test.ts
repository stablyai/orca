import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const mockOpenModal = vi.fn()
const mockToast = {
  error: vi.fn(),
  message: vi.fn(),
  success: vi.fn()
}
const mockWriteClipboardText = vi.fn(async () => undefined)
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

type KnownWorktree = {
  id: string
  repoId: string
  branch?: string
  isArchived?: boolean
  isBare?: boolean
}

type MockAgentStatus = {
  agentType?: string
  worktreeId?: string
  updatedAt?: number
  providerSession?: { key: 'session_id'; id: string }
}

type MockStore = {
  repos: { id: string; kind?: 'git' | 'folder' }[]
  agentStatusByPaneKey: Record<string, MockAgentStatus>
  retainedAgentsByPaneKey: Record<string, never>
  sleepingAgentSessionsByPaneKey: Record<string, never>
  agentLaunchConfigByPaneKey: Record<string, never>
  tabsByWorktree: Record<string, { id: string; launchAgent?: string | null }[]>
  getKnownWorktreeById: ReturnType<typeof vi.fn<(id: string) => KnownWorktree | undefined>>
  openModal: typeof mockOpenModal
}

const store: MockStore = {
  repos: [],
  agentStatusByPaneKey: {},
  retainedAgentsByPaneKey: {},
  sleepingAgentSessionsByPaneKey: {},
  agentLaunchConfigByPaneKey: {},
  tabsByWorktree: {},
  getKnownWorktreeById: vi.fn<(id: string) => KnownWorktree | undefined>(),
  openModal: mockOpenModal
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
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

function menuContext(worktreeId: string) {
  return {
    paneCwdRef: { current: new Map() },
    tabId: 'tab-1',
    worktreeId,
    groupId: null,
    fallbackCwd: '/repo',
    onAgentSessionContinuationReady: vi.fn()
  }
}

async function forkFromMenu(worktreeId: string, pane: ManagedPane | null): Promise<void> {
  const { forkAgentSessionFromMenuPane } =
    await import('./terminal-pane-menu-agent-session-actions')
  forkAgentSessionFromMenuPane(menuContext(worktreeId), pane)
}

describe('forkAgentSessionFromMenuPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.repos = [{ id: 'repo', kind: 'git' }]
    store.agentStatusByPaneKey = {}
    store.tabsByWorktree = { 'repo::wt': [{ id: 'tab-1' }] }
    store.getKnownWorktreeById.mockReturnValue({
      id: 'repo::wt',
      repoId: 'repo',
      branch: 'feature/auth'
    })
  })

  it('opens the shared fork dialog with the pane session preselected and its transcript', async () => {
    store.agentStatusByPaneKey = { [`tab-1:${LEAF_ID}`]: { agentType: 'claude' } }

    await forkFromMenu('repo::wt', makePane('User: compare OAuth options'))

    expect(mockOpenModal).toHaveBeenCalledTimes(1)
    expect(mockOpenModal).toHaveBeenCalledWith('agent-session-fork', {
      sourceWorktreeId: 'repo::wt',
      launchSource: 'terminal_context_menu',
      preselectedPaneKey: `tab-1:${LEAF_ID}`,
      transcript: {
        agent: 'claude',
        prompt: expect.stringContaining('User: compare OAuth options')
      }
    })
  })

  it('falls back to the tab launch agent for the transcript', async () => {
    store.tabsByWorktree = { 'repo::wt': [{ id: 'tab-1', launchAgent: 'codex' }] }

    await forkFromMenu('repo::wt', makePane('User: hi'))

    expect(mockOpenModal).toHaveBeenCalledWith(
      'agent-session-fork',
      expect.objectContaining({ transcript: expect.objectContaining({ agent: 'codex' }) })
    )
  })

  it('keeps the context without an agent when the pane agent is unknown', async () => {
    await forkFromMenu('repo::wt', makePane('Assistant: here is the current plan'))

    expect(mockOpenModal).toHaveBeenCalledWith('agent-session-fork', {
      sourceWorktreeId: 'repo::wt',
      launchSource: 'terminal_context_menu',
      preselectedPaneKey: `tab-1:${LEAF_ID}`,
      transcript: {
        agent: null,
        prompt: expect.stringContaining('Assistant: here is the current plan')
      }
    })
  })

  it('opens the dialog on a native session even without captured context', async () => {
    store.agentStatusByPaneKey = {
      [`tab-1:${LEAF_ID}`]: {
        agentType: 'claude',
        worktreeId: 'repo::wt',
        updatedAt: 1,
        providerSession: { key: 'session_id', id: 'sess-1' }
      }
    }

    await forkFromMenu('repo::wt', makePane('\x1b[0m\r\n\x1bc\x07'))

    expect(mockToast.error).not.toHaveBeenCalled()
    expect(mockOpenModal).toHaveBeenCalledWith('agent-session-fork', {
      sourceWorktreeId: 'repo::wt',
      launchSource: 'terminal_context_menu',
      preselectedPaneKey: `tab-1:${LEAF_ID}`,
      transcript: null
    })
  })

  it('still opens a branch-only dialog when the pane agent cannot fork natively', async () => {
    store.agentStatusByPaneKey = {
      [`tab-1:${LEAF_ID}`]: {
        agentType: 'pi',
        worktreeId: 'repo::wt',
        updatedAt: 1,
        providerSession: { key: 'session_id', id: 'sess-1' }
      }
    }

    await forkFromMenu('repo::wt', makePane('\x1b[0m\r\n\x1bc\x07'))

    expect(mockToast.error).not.toHaveBeenCalled()
    expect(mockOpenModal).toHaveBeenCalledWith(
      'agent-session-fork',
      expect.objectContaining({ transcript: null })
    )
  })

  it('does nothing without a pane', async () => {
    await forkFromMenu('repo::wt', null)

    expect(mockOpenModal).not.toHaveBeenCalled()
    expect(mockToast.error).not.toHaveBeenCalled()
  })

  it('opens a branch-only dialog for an empty terminal', async () => {
    const pane = makePane('\x1b[0m\r\n\x1bc\x07')

    await forkFromMenu('repo::wt', pane)

    expect(mockToast.error).not.toHaveBeenCalled()
    expect(mockOpenModal).toHaveBeenCalledWith('agent-session-fork', {
      sourceWorktreeId: 'repo::wt',
      launchSource: 'terminal_context_menu',
      preselectedPaneKey: `tab-1:${LEAF_ID}`,
      transcript: null
    })
  })

  it.each([
    ['has no branch', { branch: '' }, 'repo::wt'],
    ['is archived', { isArchived: true }, 'repo::wt'],
    ['is bare', { isBare: true }, 'repo::wt'],
    ['is a floating terminal', {}, FLOATING_TERMINAL_WORKTREE_ID]
  ])('does not open the dialog when the source workspace %s', async (_label, override, id) => {
    store.getKnownWorktreeById.mockReturnValue({
      id,
      repoId: 'repo',
      branch: 'feature/auth',
      ...override
    })
    const pane = makePane('User: fork this')

    await forkFromMenu(id, pane)

    expect(mockOpenModal).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(
      'This workspace cannot be forked into a git worktree.'
    )
    expect(pane.terminal.focus).toHaveBeenCalled()
  })

  it('does not open the dialog for a folder-only source workspace', async () => {
    store.repos = [{ id: 'repo', kind: 'folder' }]

    await forkFromMenu('repo::wt', makePane('User: fork this'))

    expect(mockOpenModal).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(
      'This workspace cannot be forked into a git worktree.'
    )
  })

  it('does not open the dialog when the source workspace is unknown', async () => {
    store.getKnownWorktreeById.mockReturnValue(undefined)

    await forkFromMenu('repo::wt', makePane('User: fork this'))

    expect(mockOpenModal).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(
      'Could not find the source workspace for this fork.'
    )
  })
})

describe('copyAgentSessionContextFromPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteClipboardText.mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: { ui: { writeTerminalClipboardText: mockWriteClipboardText } }
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
