import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  toastLoading: vi.fn(() => 'toast-1'),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn(),
  resolveDroppedPathsForAgent: vi.fn()
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

import {
  resolveNativeChatAttachmentOwner,
  uploadNativeChatAttachmentPaths
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

  it('resolves a runtime-owned repo to runtime', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({
          repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:env-1' }] as never
        }),
        'tab-1'
      )
    ).toEqual({ kind: 'runtime' })
  })

  it('routes unowned repos to the focused runtime host, matching terminal drops', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({ settings: { activeRuntimeEnvironmentId: 'env-9' } as AppState['settings'] }),
        'tab-1'
      )
    ).toEqual({ kind: 'runtime' })
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
