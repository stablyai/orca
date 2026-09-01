import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const mocks = vi.hoisted(() => ({
  toastLoading: vi.fn(() => 'toast-1'),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn(),
  resolveDroppedPathsForAgent: vi.fn(),
  importExternalPathsToRuntime: vi.fn(),
  getState: vi.fn(() => ({}))
}))

vi.mock('sonner', () => ({
  toast: {
    loading: mocks.toastLoading,
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
    message: mocks.toastMessage
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importExternalPathsToRuntime
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

import {
  resolveNativeChatAttachmentOwner,
  resolveNativeChatAttachmentOwnerForWorktree,
  uploadNativeChatAttachmentPaths,
  uploadNativeChatRuntimeAttachmentPaths,
  nativeChatAttachmentOwnersMatch,
  type NativeChatRuntimeAttachmentOwner
} from './native-chat-attachment-upload'

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    folderWorkspaces: [],
    getKnownWorktreeById: (worktreeId: string) =>
      worktreeId === 'wt-1' ? ({ id: 'wt-1', path: '/repo/worktree' } as never) : undefined,
    projectGroups: [],
    repos: [{ id: 'repo', connectionId: null }],
    settings: { activeRuntimeEnvironmentId: null },
    sshConnectionStates: new Map(),
    tabsByWorktree: {
      'wt-1': [terminalTab()]
    },
    worktreesByRepo: {
      repo: [{ id: 'wt-1', repoId: 'repo', path: '/repo/worktree' } as never]
    },
    ...overrides
  } as AppState
}

describe('resolveNativeChatAttachmentOwner', () => {
  it('resolves a local repo worktree to local', () => {
    expect(resolveNativeChatAttachmentOwner(state(), 'tab-1')).toEqual({ kind: 'local' })
  })

  it('resolves a structured tab owner directly from its worktree', () => {
    expect(resolveNativeChatAttachmentOwnerForWorktree(state(), 'wt-1')).toEqual({
      kind: 'local'
    })
  })

  it('resolves a structured SSH owner directly from its worktree', () => {
    expect(
      resolveNativeChatAttachmentOwnerForWorktree(
        state({
          repos: [{ id: 'repo', connectionId: 'conn-1' }] as never,
          sshConnectionStates: new Map([['conn-1', { connectionGeneration: 4 } as never]])
        }),
        'wt-1'
      )
    ).toMatchObject({
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/repo/worktree'
    })
  })

  it('resolves an SSH repo worktree to ssh with the worktree path', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({
          repos: [{ id: 'repo', connectionId: 'conn-1' }] as never,
          sshConnectionStates: new Map([['conn-1', { connectionGeneration: 4 } as never]])
        }),
        'tab-1'
      )
    ).toEqual({
      kind: 'ssh',
      connectionId: 'conn-1',
      worktreePath: '/repo/worktree',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    })
  })

  it('resolves a runtime-owned repo to a full runtime owner', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({
          repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:env-1' }] as never
        }),
        'tab-1'
      )
    ).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'env-1',
      worktreeId: 'wt-1',
      worktreePath: '/repo/worktree',
      connectionId: null,
      expectedExecutionHostId: 'local'
    })
  })

  it('carries the server-owned SSH connection on nested runtime worktrees', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({
          repos: [{ id: 'repo', connectionId: 'conn-1', executionHostId: 'runtime:env-1' }] as never
        }),
        'tab-1'
      )
    ).toMatchObject({
      kind: 'runtime',
      runtimeEnvironmentId: 'env-1',
      connectionId: 'conn-1'
    })
  })

  it('routes unowned repos to the focused runtime host, matching terminal drops', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({ settings: { activeRuntimeEnvironmentId: 'env-9' } as AppState['settings'] }),
        'tab-1'
      )
    ).toMatchObject({
      kind: 'runtime',
      runtimeEnvironmentId: 'env-9',
      worktreePath: '/repo/worktree'
    })
  })

  it('resolves the worktree path from the catalog fallback while the index hydrates', () => {
    // The tab entry path resolves via resolveNativeChatFileLinkContext, which
    // falls back to worktreesByRepo when the known-worktree index is empty.
    // The structured path (also used by the stale-owner assert's
    // re-resolution) must use the same fallback, or a mid-upload assert would
    // spuriously fail a legitimate attach as "host changed".
    expect(
      resolveNativeChatAttachmentOwnerForWorktree(
        state({
          repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:env-1' }] as never,
          getKnownWorktreeById: () => undefined
        }),
        'wt-1'
      )
    ).toMatchObject({ kind: 'runtime', worktreePath: '/repo/worktree' })
  })

  it('reports not-ready when a runtime worktree connection has not hydrated', () => {
    // The worktree row (with its runtime owner) can land before the repos
    // array that carries the server-owned connectionId — attaching then could
    // save on the wrong nested host (#17679).
    expect(
      resolveNativeChatAttachmentOwnerForWorktree(
        state({
          repos: [],
          worktreesByRepo: {
            repo: [
              {
                id: 'wt-1',
                repoId: 'repo',
                path: '/repo/worktree',
                runtimeOwnerEnvironmentId: 'env-1'
              } as never
            ]
          }
        }),
        'wt-1'
      )
    ).toEqual({ kind: 'not-ready' })
  })

  it('reports not-ready when a runtime worktree has no known path yet', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({
          repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:env-1' }] as never,
          getKnownWorktreeById: () => undefined,
          worktreesByRepo: { repo: [{ id: 'wt-1', repoId: 'repo' } as never] }
        }),
        'tab-1'
      )
    ).toEqual({ kind: 'not-ready' })
  })

  it('reports not-ready when the tab has no worktree owner', () => {
    expect(resolveNativeChatAttachmentOwner(state({ tabsByWorktree: {} }), 'tab-1')).toEqual({
      kind: 'not-ready'
    })
  })

  it('reports not-ready when the backing repo has not hydrated', () => {
    expect(resolveNativeChatAttachmentOwner(state({ repos: [] }), 'tab-1')).toEqual({
      kind: 'not-ready'
    })
  })

  it('reports not-ready when an SSH worktree has no known path yet', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({
          repos: [{ id: 'repo', connectionId: 'conn-1' }] as never,
          getKnownWorktreeById: () => undefined,
          worktreesByRepo: { repo: [{ id: 'wt-1', repoId: 'repo' } as never] },
          tabsByWorktree: { 'wt-1': [terminalTab()] }
        }),
        'tab-1'
      )
    ).toEqual({ kind: 'not-ready' })
  })
})

describe('uploadNativeChatAttachmentPaths', () => {
  const owner = {
    kind: 'ssh' as const,
    connectionId: 'conn-1',
    worktreePath: '/remote/worktree',
    expectedExecutionHostId: 'ssh:conn-1' as const,
    expectedSshTargetId: 'conn-1',
    expectedSshConnectionGeneration: 4
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: { fs: { resolveDroppedPathsForAgent: mocks.resolveDroppedPathsForAgent } }
    })
  })

  it('uploads through the terminal drop resolver and returns remote paths', async () => {
    mocks.resolveDroppedPathsForAgent.mockResolvedValue({
      resolvedPaths: ['/remote/worktree/.orca/drops/a.txt'],
      skipped: [],
      failed: []
    })
    await expect(uploadNativeChatAttachmentPaths(['/local/a.txt'], owner)).resolves.toEqual([
      '/remote/worktree/.orca/drops/a.txt'
    ])
    expect(mocks.resolveDroppedPathsForAgent).toHaveBeenCalledWith({
      paths: ['/local/a.txt'],
      worktreePath: '/remote/worktree',
      connectionId: 'conn-1',
      expectedExecutionHostId: 'ssh:conn-1',
      expectedSshTargetId: 'conn-1',
      expectedSshConnectionGeneration: 4
    })
    expect(mocks.toastLoading).toHaveBeenCalledTimes(1)
    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
  })

  it('surfaces per-file skips and failures through the shared drop toasts', async () => {
    mocks.resolveDroppedPathsForAgent.mockResolvedValue({
      resolvedPaths: [],
      skipped: [{ sourcePath: '/local/link', reason: 'symlink' }],
      failed: [{ sourcePath: '/local/b.txt', reason: 'boom' }]
    })
    await expect(
      uploadNativeChatAttachmentPaths(['/local/link', '/local/b.txt'], owner)
    ).resolves.toEqual([])
    expect(mocks.toastMessage).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('returns null and reports when the upload IPC fails', async () => {
    mocks.resolveDroppedPathsForAgent.mockRejectedValue(new Error('sftp down'))
    await expect(uploadNativeChatAttachmentPaths(['/local/a.txt'], owner)).resolves.toBeNull()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
  })
})

describe('nativeChatAttachmentOwnersMatch', () => {
  const runtimeOwner: NativeChatRuntimeAttachmentOwner = {
    kind: 'runtime',
    runtimeEnvironmentId: 'env-1',
    worktreeId: 'wt-1',
    worktreePath: '/srv/wt',
    connectionId: null,
    expectedExecutionHostId: 'local'
  }
  const sshOwner = {
    kind: 'ssh' as const,
    connectionId: 'conn-1',
    worktreePath: '/remote/wt',
    expectedExecutionHostId: 'ssh:conn-1' as const,
    expectedSshTargetId: 'conn-1',
    expectedSshConnectionGeneration: 4
  }

  it('matches owners with identical host identity', () => {
    expect(nativeChatAttachmentOwnersMatch({ kind: 'local' }, { kind: 'local' })).toBe(true)
    expect(nativeChatAttachmentOwnersMatch(runtimeOwner, { ...runtimeOwner })).toBe(true)
    expect(nativeChatAttachmentOwnersMatch(sshOwner, { ...sshOwner })).toBe(true)
  })

  it('rejects any host identity drift', () => {
    expect(nativeChatAttachmentOwnersMatch(runtimeOwner, { kind: 'local' })).toBe(false)
    expect(
      nativeChatAttachmentOwnersMatch(runtimeOwner, {
        ...runtimeOwner,
        runtimeEnvironmentId: 'env-2'
      })
    ).toBe(false)
    expect(
      nativeChatAttachmentOwnersMatch(runtimeOwner, { ...runtimeOwner, connectionId: 'conn-1' })
    ).toBe(false)
    expect(
      nativeChatAttachmentOwnersMatch(sshOwner, {
        ...sshOwner,
        expectedSshConnectionGeneration: 5
      })
    ).toBe(false)
    // not-ready can never be verified as the same host.
    expect(nativeChatAttachmentOwnersMatch(runtimeOwner, { kind: 'not-ready' })).toBe(false)
    expect(nativeChatAttachmentOwnersMatch({ kind: 'not-ready' }, { kind: 'not-ready' })).toBe(
      false
    )
  })
})

describe('uploadNativeChatRuntimeAttachmentPaths', () => {
  const owner: NativeChatRuntimeAttachmentOwner = {
    kind: 'runtime',
    runtimeEnvironmentId: 'env-1',
    worktreeId: 'wt-1',
    worktreePath: '/srv/wt',
    connectionId: null,
    expectedExecutionHostId: 'local'
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('imports into the worktree drops dir on the owning runtime and returns dest paths', async () => {
    mocks.importExternalPathsToRuntime.mockResolvedValue({
      results: [
        { sourcePath: '/local/a.png', status: 'imported', destPath: '/srv/wt/.orca/drops/a.png' },
        { sourcePath: '/local/link', status: 'skipped', reason: 'symlink' },
        { sourcePath: '/local/b.txt', status: 'failed', reason: 'boom' }
      ]
    })
    await expect(
      uploadNativeChatRuntimeAttachmentPaths(['/local/a.png', '/local/link', '/local/b.txt'], owner)
    ).resolves.toEqual(['/srv/wt/.orca/drops/a.png'])
    expect(mocks.importExternalPathsToRuntime).toHaveBeenCalledWith(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/srv/wt',
        expectedExecutionHostId: 'local',
        expectedSshTargetId: undefined,
        expectedSshConnectionGeneration: undefined
      },
      ['/local/a.png', '/local/link', '/local/b.txt'],
      '/srv/wt/.orca/drops',
      { assertCurrent: expect.any(Function) }
    )
    // Skips and failures surface through the shared drop toasts.
    expect(mocks.toastMessage).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
  })

  it('fails the in-flight upload when the owner changed underneath it', async () => {
    // Live store now says wt-1 belongs to a different environment.
    mocks.getState.mockReturnValue({
      folderWorkspaces: [],
      getKnownWorktreeById: () => ({ id: 'wt-1', path: '/srv/wt' }),
      projectGroups: [],
      repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:env-2' }],
      settings: { activeRuntimeEnvironmentId: null },
      sshConnectionStates: new Map(),
      tabsByWorktree: {},
      worktreesByRepo: { repo: [{ id: 'wt-1', repoId: 'repo', path: '/srv/wt' }] }
    })
    mocks.importExternalPathsToRuntime.mockImplementation(
      async (_context, _paths, _dest, options) => {
        options?.assertCurrent?.()
        return { results: [] }
      }
    )
    await expect(
      uploadNativeChatRuntimeAttachmentPaths(['/local/a.png'], owner)
    ).resolves.toBeNull()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('returns null and reports when the runtime import fails', async () => {
    mocks.importExternalPathsToRuntime.mockRejectedValue(new Error('pairing dropped'))
    await expect(
      uploadNativeChatRuntimeAttachmentPaths(['/local/a.png'], owner)
    ).resolves.toBeNull()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
  })
})
