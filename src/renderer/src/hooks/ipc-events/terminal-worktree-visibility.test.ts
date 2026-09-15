import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store/types'
import { setupTerminalCreateSurfacing } from '../ipc-events-terminal-create-test-harness'

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

async function setup(hostId = 'local') {
  const scenario = await setupTerminalCreateSurfacing(() => false)
  const state = scenario.storeState as unknown as AppState
  const worktreeId = 'repo-1::/hidden'
  const hidden = {
    id: worktreeId,
    repoId: 'repo-1',
    path: '/hidden',
    hostId,
    visible: false,
    ownership: 'external'
  }
  Object.assign(state, {
    repos: [
      { id: 'repo-1', executionHostId: hostId, importedExternalWorktreePaths: ['/existing'] }
    ],
    detectedWorktreesByRepo: {
      'repo-1': { authoritative: true, worktrees: [hidden] }
    },
    // Why: detected rows are known too; only the visible catalog proves a sidebar row exists.
    getKnownWorktreeById: () => hidden
  })
  const updateRepo = vi.fn(async (_id, updates) => {
    state.repos = state.repos.map((repo) => ({ ...repo, ...updates }))
    return true
  })
  const fetchWorktrees = vi.fn(async () => {
    state.worktreesByRepo = {
      ...state.worktreesByRepo,
      'repo-1': [...state.worktreesByRepo['repo-1'], hidden as never]
    }
    return true
  })
  Object.assign(state, { updateRepo, fetchWorktrees })
  return { ...scenario, state, worktreeId, updateRepo, fetchWorktrees }
}

describe.each(['reveal', 'create'] as const)('hidden worktree %s bridge', (bridge) => {
  async function invoke(scenario: Awaited<ReturnType<typeof setup>>, focused = true) {
    const payload = {
      requestId: 'request',
      worktreeId: scenario.worktreeId,
      presentation: focused ? ('focused' as const) : ('background' as const),
      source: 'runtime-session' as const
    }
    await (bridge === 'reveal'
      ? scenario.createTerminalListenerRef.current!(payload)
      : scenario.requestTerminalCreateListenerRef.current!(payload))
  }

  it.each(['local', 'ssh:server', 'runtime:server'])(
    'imports on the %s owner before activating and replying',
    async (hostId) => {
      const s = await setup(hostId)
      let finishRefresh!: () => void
      s.fetchWorktrees.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finishRefresh = resolve
        })
        s.state.worktreesByRepo = {
          ...s.state.worktreesByRepo,
          'repo-1': [...s.state.worktreesByRepo['repo-1'], { id: s.worktreeId, hostId } as never]
        }
        return true
      })
      const pending = invoke(s)
      await vi.waitFor(() => expect(s.fetchWorktrees).toHaveBeenCalled())
      expect(s.setActiveWorktree).not.toHaveBeenCalled()
      expect(s.createTab).not.toHaveBeenCalled()
      expect(s.replyTerminalCreate).not.toHaveBeenCalled()
      finishRefresh()
      await pending
      expect(s.updateRepo).toHaveBeenCalledWith(
        'repo-1',
        {
          importedExternalWorktreePaths: ['/existing', '/hidden'],
          externalWorktreeInboxBaselinePaths: ['/hidden']
        },
        { hostId }
      )
      expect(s.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
        requireAuthoritative: true,
        executionHostId: hostId
      })
      expect(s.setActiveWorktree).toHaveBeenCalledWith(s.worktreeId)
      expect(s.revealWorktreeInSidebar).toHaveBeenCalledWith(s.worktreeId)
      expect(s.replyTerminalCreate).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 'tab-new' })
      )
    }
  )

  it.each(['update', 'refresh', 'missing-row', 'unknown'])(
    'replies with an error without navigation when %s fails',
    async (failure) => {
      const s = await setup()
      if (failure === 'update') {
        s.updateRepo.mockResolvedValue(false)
      }
      if (failure === 'refresh') {
        s.fetchWorktrees.mockResolvedValue(false)
      }
      if (failure === 'missing-row') {
        s.fetchWorktrees.mockResolvedValue(true)
      }
      if (failure === 'unknown') {
        s.state.detectedWorktreesByRepo = {}
      }
      await invoke(s)
      expect(s.replyTerminalCreate).toHaveBeenCalledWith({
        requestId: 'request',
        error: expect.stringContaining('worktree_hidden')
      })
      expect(s.setActiveView).not.toHaveBeenCalled()
      expect(s.setActiveWorktree).not.toHaveBeenCalled()
      expect(s.recordWorktreeVisit).not.toHaveBeenCalled()
      expect(s.createTab).not.toHaveBeenCalled()
      expect(s.revealWorktreeInSidebar).not.toHaveBeenCalled()
      if (failure === 'refresh') {
        expect(s.updateRepo).toHaveBeenLastCalledWith(
          'repo-1',
          {
            importedExternalWorktreePaths: ['/existing'],
            externalWorktreeInboxBaselinePaths: []
          },
          { hostId: 'local' }
        )
      }
    }
  )

  it('keeps background requests hidden without activating', async () => {
    const s = await setup()
    await invoke(s, false)
    expect(s.updateRepo).not.toHaveBeenCalled()
    expect(s.setActiveWorktree).not.toHaveBeenCalled()
    if (bridge === 'reveal') {
      expect(s.createTab).toHaveBeenCalled()
    } else {
      expect(s.createTab).not.toHaveBeenCalled()
      expect(s.replyTerminalCreate).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'worktree_not_renderable' })
      )
    }
  })

  it('accepts a folder workspace without importing it as a git worktree', async () => {
    const s = await setup()
    s.worktreeId = 'folder:folder-1'
    s.state.folderWorkspaces = [{ id: 'folder-1' } as never]
    await invoke(s)
    expect(s.updateRepo).not.toHaveBeenCalled()
    expect(s.setActiveWorktree).toHaveBeenCalledWith(s.worktreeId)
  })
})

describe('terminal worktree activation safety', () => {
  it('rejects direct activation of a detected hidden row', async () => {
    const s = await setup()
    const { activateTerminalInitiatedWorktree } = await import('./terminal-command-state')
    expect(() => activateTerminalInitiatedWorktree(s.state, s.worktreeId)).toThrow(
      'worktree_hidden'
    )
    expect(s.setActiveView).not.toHaveBeenCalled()
    expect(s.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('coalesces simultaneous reveals of the same hidden worktree', async () => {
    const s = await setup()
    const { ensureTerminalWorktreeVisible } = await import('./terminal-worktree-visibility')
    await Promise.all([
      ensureTerminalWorktreeVisible(s.worktreeId),
      ensureTerminalWorktreeVisible(s.worktreeId)
    ])
    expect(s.updateRepo).toHaveBeenCalledTimes(1)
    expect(s.fetchWorktrees).toHaveBeenCalledTimes(1)
  })

  it('preserves both imports for simultaneous reveals in the same repo', async () => {
    const s = await setup()
    const second = {
      ...s.state.detectedWorktreesByRepo['repo-1'].worktrees[0],
      id: 'repo-1::/second',
      path: '/second'
    }
    s.state.detectedWorktreesByRepo['repo-1'].worktrees.push(second)
    s.fetchWorktrees.mockImplementation(async () => {
      s.state.worktreesByRepo = {
        'repo-1': s.state.detectedWorktreesByRepo['repo-1'].worktrees.filter((row) =>
          s.state.repos[0].importedExternalWorktreePaths?.includes(row.path)
        )
      }
      return true
    })
    const { ensureTerminalWorktreeVisible } = await import('./terminal-worktree-visibility')
    await Promise.all([
      ensureTerminalWorktreeVisible(s.worktreeId),
      ensureTerminalWorktreeVisible(second.id)
    ])
    expect(s.state.repos[0].importedExternalWorktreePaths).toEqual([
      '/existing',
      '/hidden',
      '/second'
    ])
  })
})

describe('direct terminal focus events', () => {
  it('imports before focusing the requested terminal', async () => {
    const s = await setup()
    await s.focusTerminalListenerRef.current!({ worktreeId: s.worktreeId, tabId: 'existing' })
    expect(s.updateRepo).toHaveBeenCalledTimes(1)
    expect(s.setActiveWorktree).toHaveBeenCalledWith(s.worktreeId)
    expect(s.setActiveTab).toHaveBeenCalledWith('existing')
  })

  it('handles a failed import without an uncaught rejection or navigation', async () => {
    const s = await setup()
    s.updateRepo.mockResolvedValue(false)
    await expect(
      s.focusTerminalListenerRef.current!({ worktreeId: s.worktreeId, tabId: 'existing' })
    ).resolves.toBeUndefined()
    expect(s.setActiveWorktree).not.toHaveBeenCalled()
    expect(s.setActiveTab).not.toHaveBeenCalled()
  })
})

describe.each(['ssh:server', 'runtime:server'] as const)('same-ID %s ownership', (hostId) => {
  it('imports the selected host despite a visible local row with the same ID', async () => {
    const s = await setup(hostId)
    s.state.activeWorktreeId = s.worktreeId
    s.state.activeWorkspaceExecutionHostId = hostId
    s.state.worktreesByRepo = {
      'repo-1': [{ id: s.worktreeId, repoId: 'repo-1', hostId: 'local' } as never]
    }
    const { ensureTerminalWorktreeVisible, hasTerminalWorktreeRow } =
      await import('./terminal-worktree-visibility')
    expect(hasTerminalWorktreeRow(s.state, s.worktreeId)).toBe(false)
    await ensureTerminalWorktreeVisible(s.worktreeId)
    expect(s.updateRepo).toHaveBeenCalledWith('repo-1', expect.anything(), { hostId })
    expect(hasTerminalWorktreeRow(s.state, s.worktreeId)).toBe(true)
  })

  it('refuses ambiguous ownership instead of accepting the visible local row', async () => {
    const s = await setup(hostId)
    s.state.worktreesByRepo = {
      'repo-1': [{ id: s.worktreeId, repoId: 'repo-1', hostId: 'local' } as never]
    }
    const { ensureTerminalWorktreeVisible } = await import('./terminal-worktree-visibility')
    await expect(ensureTerminalWorktreeVisible(s.worktreeId)).rejects.toThrow('worktree_hidden')
    expect(s.updateRepo).not.toHaveBeenCalled()
  })
})
