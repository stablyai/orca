import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getDefaultSettings } from '../../../../shared/constants'

const mocks = vi.hoisted(() => ({
  toastLoading: vi.fn(() => 'toast-1'),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn(),
  resolveDroppedPathsForAgent: vi.fn(),
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

vi.mock('sonner', () => ({
  toast: {
    loading: mocks.toastLoading,
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
    message: mocks.toastMessage
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name]))
}))

import {
  nativeChatAttachFailedNotice,
  prepareNativeChatSessionAttachmentUpload,
  resolveNativeChatAttachmentOwner,
  resolveNativeChatAttachmentOwnerForWorktree,
  resolveNativeChatRuntimeSessionAttachmentOwner,
  uploadNativeChatAttachmentPaths
} from './native-chat-attachment-upload'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { repoFixture, worktreeFixture } from './native-chat-workspace-test-fixtures'

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

type OwnerState = Parameters<typeof resolveNativeChatAttachmentOwner>[0]

function state(overrides: Partial<OwnerState> = {}): OwnerState {
  return {
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    floatingWorkspacePath: null,
    projectGroups: [],
    repos: [repoFixture({ connectionId: null })],
    settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: null },
    sshConnectionStates: new Map(),
    tabsByWorktree: {
      'wt-1': [terminalTab()]
    },
    unifiedTabsByWorktree: {},
    worktreesByRepo: {
      repo: [
        worktreeFixture('wt-1', '/repo/worktree', {
          hostId:
            overrides.repos?.length === 0
              ? undefined
              : getRepoExecutionHostId(overrides.repos?.[0] ?? { connectionId: null })
        })
      ]
    },
    ...overrides
  }
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

  it('keeps a recorded local workspace local when a runtime is focused', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({ settings: { activeRuntimeEnvironmentId: 'env-9' } as AppState['settings'] }),
        'tab-1'
      )
    ).toEqual({ kind: 'local' })
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

  it('reports not-ready instead of throwing when the SSH generation is gone', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({
          repos: [{ id: 'repo', connectionId: 'conn-1' }] as never,
          sshConnectionStates: new Map()
        }),
        'tab-1'
      )
    ).toEqual({ kind: 'not-ready' })
  })

  it('reports not-ready when an SSH worktree has no known path yet', () => {
    expect(
      resolveNativeChatAttachmentOwner(
        state({
          repos: [{ id: 'repo', connectionId: 'conn-1' }] as never,
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

describe('a structured chat on a paired server', () => {
  const owner = {
    kind: 'runtime-session' as const,
    environmentId: 'env-1',
    pairingRevision: 7,
    sessionId: 'session-1'
  }

  beforeEach(() => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
    mocks.callRuntimeRpc.mockReset()
  })

  it('owns its attachments by the server it runs on and that pairing', () => {
    expect(
      resolveNativeChatRuntimeSessionAttachmentOwner({
        sessionId: 'session-1',
        runtimeEnvironmentId: 'env-1'
      })
    ).toEqual(owner)
    expect(
      resolveNativeChatRuntimeSessionAttachmentOwner({
        sessionId: 'session-1',
        runtimeEnvironmentId: 'env-gone'
      })
    ).toEqual({ kind: 'not-ready' })
  })

  it('asks the server, pinned to the pairing, and uploads only where it keeps a store', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      runtimeId: 'runtime-a',
      capabilities: [AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY]
    })
    await expect(prepareNativeChatSessionAttachmentUpload(owner)).resolves.toEqual({
      ok: true,
      target: {
        environmentId: 'env-1',
        sessionId: 'session-1',
        expectedEnvironmentPairingRevision: 7,
        expectedEnvironmentRuntimeId: 'runtime-a'
      }
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'status.get',
      undefined,
      expect.objectContaining({ expectedEnvironmentPairingRevision: 7 })
    )
  })

  it('tells the user to update an older server instead of uploading', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ runtimeId: 'runtime-a', capabilities: [] })
    await expect(prepareNativeChatSessionAttachmentUpload(owner)).resolves.toEqual({
      ok: false,
      notice:
        'This needs a newer Orca on the computer running this chat. Update Orca there, then try again.'
    })
  })
})

describe('nativeChatAttachFailedNotice', () => {
  it('ends the shared cause with one full stop, whatever script it is written in', () => {
    expect(nativeChatAttachFailedNotice(['a.mov'], 'over the 50 MB limit')).toBe(
      "Couldn't attach a.mov. over the 50 MB limit."
    )
    expect(nativeChatAttachFailedNotice(['a'], 'サポートされていないファイル形式です。')).toBe(
      "Couldn't attach a. サポートされていないファイル形式です。"
    )
    expect(nativeChatAttachFailedNotice(['a'], '不支持的文件类型！')).toBe(
      "Couldn't attach a. 不支持的文件类型！"
    )
    expect(nativeChatAttachFailedNotice(['a', 'b'])).toBe("Couldn't attach a, b.")
  })
})
