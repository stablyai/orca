import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/git-status-types'

const mocks = vi.hoisted(() => ({
  state: {
    repos: [
      { id: 'repo', connectionId: null, executionHostId: 'local' },
      { id: 'repo', connectionId: 'host', executionHostId: 'ssh:host' },
      { id: 'repo', connectionId: null, executionHostId: 'runtime:server' }
    ],
    settings: { activeRuntimeEnvironmentId: 'other-server' }
  },
  worktree: { id: 'same-id', repoId: 'repo', path: '/server/workspace' },
  getWorktree: vi.fn(),
  activate: vi.fn(),
  gitStatus: vi.fn(),
  openEntry: vi.fn(),
  error: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/store/selectors', () => ({ getWorktreeOnHostFromState: mocks.getWorktree }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: mocks.activate }))
vi.mock('@/runtime/runtime-git-status-client', () => ({ getRuntimeGitStatus: mocks.gitStatus }))
vi.mock('../right-sidebar/source-control/listing/open-uncommitted-entry', () => ({
  openUncommittedEntry: mocks.openEntry
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))

import { revealWorkspaceSpaceChange } from './workspace-space-open-change'

const entry: GitStatusEntry = { path: 'src/app.ts', area: 'staged', status: 'modified' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getWorktree.mockReturnValue(mocks.worktree)
  mocks.gitStatus.mockResolvedValue({ entries: [entry] })
  mocks.activate.mockReturnValue({ primaryTabId: null })
})

describe('Space change inspection', () => {
  it.each([
    ['local', { kind: 'local' }, null],
    ['ssh:host', { kind: 'local' }, null],
    ['runtime:server', { kind: 'environment', environmentId: 'server' }, 'server']
  ] as const)(
    'opens the diff on the selected host %s',
    async (hostId, target, runtimeEnvironmentId) => {
      await revealWorkspaceSpaceChange('same-id', hostId, entry)
      expect(mocks.getWorktree).toHaveBeenCalledWith(mocks.state, 'same-id', hostId)
      expect(mocks.gitStatus).toHaveBeenCalledWith(
        {
          target,
          worktreeId: 'same-id',
          worktreePath: '/server/workspace',
          connectionId: hostId === 'ssh:host' ? 'host' : undefined
        },
        { includeLineStats: false }
      )
      expect(mocks.activate).toHaveBeenCalledWith('same-id', {
        navigationIntent: 'user-open',
        providesInitialSurface: true,
        executionHostId: hostId
      })
      expect(mocks.openEntry).toHaveBeenCalledWith(
        mocks.state,
        'same-id',
        '/server/workspace',
        entry,
        { preview: true, runtimeEnvironmentId }
      )
    }
  )

  it('uses the workspace owner when a legacy reveal omits the host', async () => {
    mocks.getWorktree.mockReturnValue({ ...mocks.worktree, hostId: 'runtime:server' })
    await revealWorkspaceSpaceChange('same-id', undefined, entry)
    expect(mocks.gitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'environment', environmentId: 'server' } }),
      { includeLineStats: false }
    )
    expect(mocks.activate).toHaveBeenCalledWith(
      'same-id',
      expect.objectContaining({ executionHostId: 'runtime:server' })
    )
  })

  it('uses current conflict metadata from the execution host', async () => {
    const conflict = { ...entry, conflictKind: 'both_deleted', conflictStatus: 'unresolved' }
    mocks.gitStatus.mockResolvedValue({ entries: [conflict] })
    await revealWorkspaceSpaceChange('same-id', 'local', entry)
    expect(mocks.openEntry.mock.calls[0][3]).toBe(conflict)
  })

  it('reports a stale change without navigating or opening a file', async () => {
    mocks.gitStatus.mockResolvedValue({ entries: [{ ...entry, area: 'unstaged' }] })
    await revealWorkspaceSpaceChange('same-id', 'runtime:server', entry)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.openEntry).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledOnce()
  })

  it('does not fall back to a different host when its owner is unavailable', async () => {
    mocks.getWorktree.mockReturnValue(undefined)
    await revealWorkspaceSpaceChange('same-id', 'ssh:gone', entry)
    expect(mocks.gitStatus).not.toHaveBeenCalled()
    expect(mocks.openEntry).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledOnce()
  })
})
