import { describe, expect, it, vi } from 'vitest'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../../../shared/workspace-session/workspace-session-state-types'
import { pruneClosedOpenFileFromAllPartitions, type PartitionSessionApi } from './prune-closed-open-file'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

const WORKTREE = 'wt-1'
const FILE_A = '/repo/notes.md'
const FILE_B = '/repo/other.md'

function persistedOpenFile(overrides: Partial<PersistedOpenFile>): PersistedOpenFile {
  return {
    filePath: FILE_A,
    relativePath: 'notes.md',
    worktreeId: WORKTREE,
    language: 'markdown',
    ...overrides
  }
}

function sessionSlice(openFiles: PersistedOpenFile[]): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: { [WORKTREE]: openFiles }
  }
}

function mockApi(partitions: Record<string, WorkspaceSessionState | Error>) {
  const sets: Array<{ hostId?: string; state: WorkspaceSessionState }> = []
  const api: PartitionSessionApi = {
    get: vi.fn(async (hostId?: string) => {
      const slice = partitions[hostId ?? 'local']
      if (slice instanceof Error) {
        throw slice
      }
      return slice
    }),
    set: vi.fn(async (state: WorkspaceSessionState, hostId?: string) => {
      sets.push({ hostId, state })
    }),
    listHostIds: vi.fn(
      async () =>
        // SAFETY: mock partitions are keyed by host-id-shaped strings ('local', 'ssh:…', 'runtime:…').
        Object.keys(partitions).filter((id) => id !== 'local') as ExecutionHostId[]
    )
  }
  return { api, sets }
}

describe('pruneClosedOpenFileFromAllPartitions', () => {
  it('drops the closed file row from every partition that still holds it', async () => {
    const staleRow = persistedOpenFile({
      filePath: FILE_A,
      dirtyDraftContent: 'unsaved',
      lastKnownDiskSignature: 'sig-1'
    })
    const { api, sets } = mockApi({
      local: sessionSlice([]),
      'ssh:legacy': sessionSlice([staleRow, persistedOpenFile({ filePath: FILE_B, relativePath: 'other.md' })]),
      'runtime:env': sessionSlice([persistedOpenFile({ mirroredFromRuntimeSession: true })])
    })

    await pruneClosedOpenFileFromAllPartitions(api, { worktreeId: WORKTREE, filePath: FILE_A })

    expect(api.set).toHaveBeenCalledTimes(2)
    const sshWrite = sets.find((entry) => entry.hostId === 'ssh:legacy')?.state
    expect(sshWrite?.openFilesByWorktree?.[WORKTREE]).toEqual([
      persistedOpenFile({ filePath: FILE_B, relativePath: 'other.md' })
    ])
    const runtimeWrite = sets.find((entry) => entry.hostId === 'runtime:env')?.state
    expect(runtimeWrite?.openFilesByWorktree?.[WORKTREE]).toBeUndefined()
  })

  it('leaves partitions without the file untouched', async () => {
    const { api, sets } = mockApi({
      local: sessionSlice([]),
      'ssh:legacy': sessionSlice([persistedOpenFile({ filePath: FILE_B, relativePath: 'other.md' })])
    })

    await pruneClosedOpenFileFromAllPartitions(api, { worktreeId: WORKTREE, filePath: FILE_A })

    expect(api.set).not.toHaveBeenCalled()
    expect(sets).toEqual([])
  })

  it('keeps other worktrees intact while pruning the closed one', async () => {
    const row = persistedOpenFile({})
    const otherWorktreeRow = persistedOpenFile({ worktreeId: 'wt-2', filePath: FILE_A, relativePath: 'notes.md' })
    const { api, sets } = mockApi({
      local: {
        ...sessionSlice([row]),
        openFilesByWorktree: { [WORKTREE]: [row], 'wt-2': [otherWorktreeRow] }
      }
    })

    await pruneClosedOpenFileFromAllPartitions(api, { worktreeId: WORKTREE, filePath: FILE_A })

    const localWrite = sets.find((entry) => entry.hostId === undefined || entry.hostId === 'local')?.state
    expect(localWrite?.openFilesByWorktree).toEqual({ 'wt-2': [otherWorktreeRow] })
  })

  it('a partition read failure does not block pruning the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { api, sets } = mockApi({
        local: sessionSlice([]),
        'ssh:legacy': new Error('unreadable'),
        'runtime:env': sessionSlice([persistedOpenFile({})])
      })

      await pruneClosedOpenFileFromAllPartitions(api, { worktreeId: WORKTREE, filePath: FILE_A })

      expect(api.set).toHaveBeenCalledTimes(1)
      expect(sets[0]?.hostId).toBe('runtime:env')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
