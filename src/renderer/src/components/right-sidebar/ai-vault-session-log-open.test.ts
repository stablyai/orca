import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toastMock, toastErrorMock, getStateMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  toastErrorMock: vi.fn(),
  getStateMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: Object.assign(toastMock, { error: toastErrorMock })
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/i18n/i18n', () => ({
  // Return the English fallback so assertions can match user-facing copy.
  translate: (_key: string, fallback: string) => fallback
}))

import { openAiVaultSessionLogInOrca } from './ai-vault-session-log-open'

const LOG_PATH = '/home/user/.claude/sessions/log.jsonl'

type FakeState = {
  activeWorktreeId: string | null
  activeGroupIdByWorktree: Record<string, string>
  openFiles: Record<string, unknown>[]
  worktreesByRepo: Record<string, { id: string }[]>
  folderWorkspaces: { id: string }[]
  openFile: ReturnType<typeof vi.fn>
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    activeWorktreeId: 'wt-1',
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    openFiles: [],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1' }] },
    folderWorkspaces: [],
    openFile: vi.fn(),
    ...overrides
  }
}

let authorizeMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  authorizeMock = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { fs: { authorizeExternalPath: authorizeMock } } })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('openAiVaultSessionLogInOrca', () => {
  it('authorizes the exact path and opens a permanent read-only local tab', async () => {
    const state = makeState()
    getStateMock.mockReturnValue(state)

    await openAiVaultSessionLogInOrca({ filePath: LOG_PATH, executionHostId: 'local' })

    expect(authorizeMock).toHaveBeenCalledWith({ targetPath: LOG_PATH })
    expect(state.openFile).toHaveBeenCalledTimes(1)
    const [file, options] = state.openFile.mock.calls[0]
    expect(file).toEqual({
      filePath: LOG_PATH,
      relativePath: LOG_PATH,
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      language: 'jsonl',
      mode: 'edit',
      readOnly: true,
      liveTail: true
    })
    expect(options).toEqual({
      preview: false,
      forceContentReload: true,
      suppressActiveRuntimeFallback: true,
      targetGroupId: 'group-1'
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('withholds blank, remote, and synthetic paths without authorizing', async () => {
    const state = makeState()
    getStateMock.mockReturnValue(state)

    await openAiVaultSessionLogInOrca({ filePath: '   ', executionHostId: 'local' })
    await openAiVaultSessionLogInOrca({ filePath: LOG_PATH, executionHostId: 'ssh:dev-box' })
    await openAiVaultSessionLogInOrca({
      filePath: '/home/user/.opencode/db.sqlite#sess_1',
      executionHostId: 'local'
    })

    expect(authorizeMock).not.toHaveBeenCalled()
    expect(state.openFile).not.toHaveBeenCalled()
  })

  it('toasts and creates no tab when authorization rejects', async () => {
    const state = makeState()
    getStateMock.mockReturnValue(state)
    authorizeMock.mockRejectedValue(new Error('denied'))

    await openAiVaultSessionLogInOrca({ filePath: LOG_PATH, executionHostId: 'local' })

    expect(state.openFile).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't open log — path not authorized.")
  })

  it('toasts and creates no tab when the workspace vanishes after authorization', async () => {
    const state = makeState()
    const stateAfter = makeState({ worktreesByRepo: {}, folderWorkspaces: [] })
    getStateMock.mockReturnValueOnce(state).mockReturnValue(stateAfter)

    await openAiVaultSessionLogInOrca({ filePath: LOG_PATH, executionHostId: 'local' })

    expect(state.openFile).not.toHaveBeenCalled()
    expect(stateAfter.openFile).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Couldn't open log — workspace is no longer available."
    )
  })

  it('activates and shows the already-editable toast for an existing writable tab', async () => {
    const state = makeState({
      openFiles: [
        {
          filePath: LOG_PATH,
          mode: 'edit',
          worktreeId: 'wt-1',
          runtimeEnvironmentId: null,
          readOnly: undefined
        }
      ]
    })
    getStateMock.mockReturnValue(state)

    await openAiVaultSessionLogInOrca({ filePath: LOG_PATH, executionHostId: 'local' })

    expect(state.openFile).toHaveBeenCalledTimes(1)
    expect(toastMock).toHaveBeenCalledWith('Log is already open for editing.')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('shares one in-flight open for concurrent clicks of the same path', async () => {
    const state = makeState()
    getStateMock.mockReturnValue(state)
    let resolveAuth: (() => void) | undefined
    authorizeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAuth = resolve
        })
    )

    const first = openAiVaultSessionLogInOrca({ filePath: LOG_PATH, executionHostId: 'local' })
    const second = openAiVaultSessionLogInOrca({ filePath: LOG_PATH, executionHostId: 'local' })
    resolveAuth?.()
    await Promise.all([first, second])

    expect(authorizeMock).toHaveBeenCalledTimes(1)
    expect(state.openFile).toHaveBeenCalledTimes(1)
  })
})
