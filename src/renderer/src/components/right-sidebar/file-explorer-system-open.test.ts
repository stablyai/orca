import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isFileExplorerLocalOpenBlocked,
  openFileExplorerPathWithSystemDefault,
  resolveActiveWorkspaceConnectionId,
  type FileExplorerLocalOpenState
} from './file-explorer-system-open'

const { getStateMock, toastErrorMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  toastErrorMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

vi.mock('@/i18n/i18n', () => ({
  // Return the English fallback so assertions can match user-facing copy.
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))

function stateWith(
  overrides: Partial<FileExplorerLocalOpenState> = {}
): FileExplorerLocalOpenState {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    repos: [{ id: 'repo-1', connectionId: null }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    activeWorktreeId: 'wt-1',
    ...overrides
  }
}

function stubOpenFilePath(opened: boolean): ReturnType<typeof vi.fn> {
  const openFilePath = vi.fn().mockResolvedValue(opened)
  ;(
    globalThis as unknown as {
      window: { api: { shell: { openFilePath: typeof openFilePath } } }
    }
  ).window = { api: { shell: { openFilePath } } }
  return openFilePath
}

beforeEach(() => {
  getStateMock.mockReset()
  toastErrorMock.mockReset()
})

describe('resolveActiveWorkspaceConnectionId', () => {
  it('returns the SSH connection that owns the active workspace', () => {
    expect(
      resolveActiveWorkspaceConnectionId(
        stateWith({ repos: [{ id: 'repo-1', connectionId: 'ssh-1' }] })
      )
    ).toBe('ssh-1')
  })

  it('returns null for local workspaces and for unknown worktree ids', () => {
    expect(resolveActiveWorkspaceConnectionId(stateWith())).toBeNull()
    expect(resolveActiveWorkspaceConnectionId(stateWith({ activeWorktreeId: 'wt-missing' }))).toBe(
      null
    )
  })
})

describe('isFileExplorerLocalOpenBlocked', () => {
  it('allows local workspaces without an active runtime', () => {
    expect(isFileExplorerLocalOpenBlocked(stateWith())).toBe(false)
  })

  it('blocks SSH workspaces', () => {
    expect(
      isFileExplorerLocalOpenBlocked(
        stateWith({ repos: [{ id: 'repo-1', connectionId: 'ssh-1' }] })
      )
    ).toBe(true)
  })

  it('blocks whenever a remote runtime is active', () => {
    expect(
      isFileExplorerLocalOpenBlocked(
        stateWith({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } })
      )
    ).toBe(true)
  })
})

describe('openFileExplorerPathWithSystemDefault', () => {
  it('hands local paths to the OS file association', async () => {
    getStateMock.mockReturnValue(stateWith())
    const openFilePath = stubOpenFilePath(true)

    await openFileExplorerPathWithSystemDefault('/repo/src/index.ts')

    expect(openFilePath).toHaveBeenCalledWith('/repo/src/index.ts')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('refuses remote paths instead of opening a client-side path', async () => {
    getStateMock.mockReturnValue(stateWith({ repos: [{ id: 'repo-1', connectionId: 'ssh-1' }] }))
    const openFilePath = stubOpenFilePath(true)

    await openFileExplorerPathWithSystemDefault('/repo/src/index.ts')

    expect(openFilePath).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Opening remote paths in the local OS is not available.'
    )
  })

  it('names the entry when the OS has no handler for it', async () => {
    getStateMock.mockReturnValue(stateWith())
    stubOpenFilePath(false)

    await openFileExplorerPathWithSystemDefault('/repo/src/index.ts')

    expect(toastErrorMock).toHaveBeenCalledWith(
      "Couldn't open 'index.ts' with the system default app."
    )
  })
})
