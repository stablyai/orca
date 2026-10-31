import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
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

beforeEach(() => {
  vi.stubGlobal('window', { api: { fs: {} } })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('openAiVaultSessionLogInOrca', () => {
  it('opens the exact path as a permanent read-only local tab', async () => {
    const state = makeState()
    getStateMock.mockReturnValue(state)

    await openAiVaultSessionLogInOrca({
      agent: 'claude',
      filePath: LOG_PATH,
      executionHostId: 'local'
    })

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

  it.each<[AiVaultAgent, string]>([
    ['claude', String.raw`\\wsl.localhost\Ubuntu\home\User\Session.JsOnL`],
    ['jcode', '/home/User/.jcode/sessions/session_123.JsOn']
  ])('opens the accepted %s extension without changing path case', async (agent, filePath) => {
    const state = makeState()
    getStateMock.mockReturnValue(state)

    await openAiVaultSessionLogInOrca({ agent, filePath, executionHostId: 'local' })

    expect(state.openFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ filePath, relativePath: filePath, readOnly: true, liveTail: true }),
      expect.objectContaining({ suppressActiveRuntimeFallback: true })
    )
  })

  it('withholds blank, remote, and synthetic paths', async () => {
    const state = makeState()
    getStateMock.mockReturnValue(state)

    await openAiVaultSessionLogInOrca({
      agent: 'claude',
      filePath: '   ',
      executionHostId: 'local'
    })
    await openAiVaultSessionLogInOrca({
      agent: 'claude',
      filePath: LOG_PATH,
      executionHostId: 'ssh:dev-box'
    })
    await openAiVaultSessionLogInOrca({
      agent: 'opencode',
      filePath: '/home/user/.opencode/db.sqlite#sess_1',
      executionHostId: 'local'
    })

    expect(state.openFile).not.toHaveBeenCalled()
  })

  it('never opens a plain OpenCode V2 database', async () => {
    const state = makeState()
    getStateMock.mockReturnValue(state)
    const session: Pick<AiVaultSession, 'agent' | 'filePath' | 'executionHostId'> = {
      agent: 'opencode2',
      filePath: '/home/user/.local/share/opencode/opencode.db',
      executionHostId: 'local'
    }
    await openAiVaultSessionLogInOrca(session)
    expect(state.openFile).not.toHaveBeenCalled()
  })

  it.each<[AiVaultAgent, string, string]>([
    ['grok', '/home/user/sessions/s/summary.json', '/home/user/sessions/s/chat_history.jsonl'],
    ['rovo', '/home/user/sessions/s/metadata.json', '/home/user/sessions/s/session_context.json'],
    ['cline', '/home/user/sessions/s/s.json', '/home/user/sessions/s/s.messages.json'],
    [
      'kiro',
      '/home/user/.kiro/sessions/cli/7f25fc86-c185-4082-8d13-eb209867d286.json',
      '/home/user/.kiro/sessions/cli/7f25fc86-c185-4082-8d13-eb209867d286.jsonl'
    ],
    [
      'grok',
      String.raw`C:\Users\a\sessions\s\summary.json`,
      String.raw`C:\Users\a\sessions\s\chat_history.jsonl`
    ],
    [
      'grok',
      String.raw`\\wsl.localhost\Ubuntu\home\User\sessions\s\summary.json`,
      String.raw`\\wsl.localhost\Ubuntu\home\User\sessions\s\chat_history.jsonl`
    ],
    [
      'grok',
      String.raw`\\wsl$\Ubuntu\home\User\sessions\s\summary.json`,
      String.raw`\\wsl$\Ubuntu\home\User\sessions\s\chat_history.jsonl`
    ]
  ])('opens the %s conversation companion of %s', async (agent, filePath, conversationPath) => {
    const state = makeState()
    getStateMock.mockReturnValue(state)
    // Counts describe parsed turns, not whether the source format has a file resource.
    const session: Pick<AiVaultSession, 'agent' | 'filePath' | 'executionHostId' | 'messageCount'> =
      {
        agent,
        filePath,
        executionHostId: 'local',
        messageCount: 0
      }
    await openAiVaultSessionLogInOrca(session)
    expect(state.openFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        filePath: conversationPath,
        relativePath: conversationPath,
        runtimeEnvironmentId: null,
        readOnly: true,
        liveTail: true
      }),
      expect.objectContaining({ suppressActiveRuntimeFallback: true })
    )
  })

  it('toasts and creates no tab when the workspace no longer exists', async () => {
    const state = makeState({ worktreesByRepo: {}, folderWorkspaces: [] })
    getStateMock.mockReturnValue(state)

    await openAiVaultSessionLogInOrca({
      agent: 'claude',
      filePath: LOG_PATH,
      executionHostId: 'local'
    })

    expect(state.openFile).not.toHaveBeenCalled()
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

    await openAiVaultSessionLogInOrca({
      agent: 'claude',
      filePath: LOG_PATH,
      executionHostId: 'local'
    })

    expect(state.openFile).toHaveBeenCalledTimes(1)
    expect(toastMock).toHaveBeenCalledWith('Log is already open for editing.')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })
})
