import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, inspectRuntimeTerminalProcessMock, getStatusFeedMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn(),
  getStatusFeedMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

vi.mock('@/runtime/native-chat/status/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: getStatusFeedMock
}))

import { assessWindowCloseRunningWork } from './window-close-running-work'

const LOCAL_PTY = 'pty-local'
const SSH_PTY = 'ssh:openclaw@@pty-7'
const RUNTIME_PTY = 'remote:env-1@@handle-1'
const OWNERLESS_RUNTIME_PTY = 'remote:handle-2'

const BUSY = {
  foregroundProcess: 'pnpm build',
  hasChildProcesses: true,
  foregroundProcessEvidence: {}
}

const UNVERIFIABLE = {
  foregroundProcess: null,
  hasChildProcesses: false,
  verdict: 'unverifiable',
  reason: 'transport_loss'
}

function setState(ptyIds: string[]): void {
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
    ptyIdsByTabId: { 'tab-1': ptyIds },
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {}
  })
}

function chat(executionHostId: string | undefined = 'local') {
  return {
    contentType: 'agent-session',
    entityId: 'chat-1',
    worktreeId: 'worktree-1',
    executionHostId
  }
}

function representChat(executionHostId?: string): void {
  getStateMock().unifiedTabsByWorktree = {
    'worktree-1': [chat(executionHostId)]
  }
}

function feed(status: string | null | undefined, observation = 'live', extra = {}) {
  return {
    getSnapshot: () => new Map(status === undefined ? [] : [['chat-1', { status, ...extra }]]),
    getSessionObservation: () => observation
  }
}

function answerWith(byPtyId: Record<string, unknown>): void {
  inspectRuntimeTerminalProcessMock.mockImplementation((ptyId: string) =>
    ptyId in byPtyId ? Promise.resolve(byPtyId[ptyId]) : new Promise(() => {})
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getStatusFeedMock.mockReturnValue(feed(null, 'unverifiable'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('assessWindowCloseRunningWork', () => {
  it.each(['working', 'attention'])(
    'warns for a live %s chat without a PTY or ownership metadata',
    async (status) => {
      setState([])
      representChat()
      getStatusFeedMock.mockReturnValue(feed(status))

      await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
        kind: 'running'
      })
      expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['working', 'unverifiable', {}],
    ['idle', 'live', { hostExecutionOwned: true, children: [{ kind: 'agent', state: 'working' }] }],
    ['idle', 'live', { children: [{ kind: 'agent', state: 'unverifiable' }] }],
    [null, 'live', {}],
    [undefined, 'live', {}]
  ])('does not warn for status %s observed as %s', async (status, observation, extra) => {
    setState([])
    representChat()
    getStatusFeedMock.mockReturnValue(feed(status, observation, extra))

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'none'
    })
  })

  it('keeps equal chat IDs separate across hosts and resolves legacy tabs through their workspace owner', async () => {
    setState([])
    const state = getStateMock()
    state.repos = [{ id: 'repo-1', executionHostId: 'runtime:env-1' }]
    state.worktreesByRepo = {
      'repo-1': [{ id: 'worktree-1', repoId: 'repo-1', hostId: 'runtime:env-1' }]
    }
    state.unifiedTabsByWorktree = {
      'worktree-1': [chat('local'), { ...chat(), executionHostId: undefined }]
    }
    getStatusFeedMock.mockImplementation((target) =>
      feed(target.kind === 'environment' && target.environmentId === 'env-1' ? 'working' : 'idle')
    )

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'running'
    })
  })

  it('does not use a local observation for an unserved SSH chat', async () => {
    setState([])
    representChat('ssh:openclaw')
    getStatusFeedMock.mockReturnValue(feed('working'))

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'none'
    })
    expect(getStatusFeedMock).not.toHaveBeenCalled()
  })

  it('uses current chat membership, owner and status after terminal probes settle', async () => {
    setState([LOCAL_PTY])
    representChat()
    getStatusFeedMock.mockReturnValue(feed('working'))
    let finishProbe!: (value: unknown) => void
    inspectRuntimeTerminalProcessMock.mockReturnValue(
      new Promise((resolve) => {
        finishProbe = resolve
      })
    )
    const assessment = assessWindowCloseRunningWork({ isQuitting: false })
    setState([])
    representChat('runtime:env-2')
    getStatusFeedMock.mockImplementation((target) =>
      feed(target.kind === 'local' ? 'working' : 'idle')
    )
    finishProbe({ foregroundProcess: null, hasChildProcesses: false })

    await expect(assessment).resolves.toEqual({ kind: 'none' })
    expect(getStatusFeedMock).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'env-2' })
  })

  it('prefers a live chat over unverifiable remote terminal work, but never reads chats on quit', async () => {
    setState([SSH_PTY])
    representChat()
    answerWith({ [SSH_PTY]: UNVERIFIABLE })
    getStatusFeedMock.mockReturnValue(feed('working'))

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'running'
    })
    getStatusFeedMock.mockClear()
    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'unverifiable'
    })
    expect(getStatusFeedMock).not.toHaveBeenCalled()
  })
  // #29916: a paired runtime owns its terminals and keeps them after this client quits.
  it('does not warn on quit, or probe, for a live process on a paired runtime host', async () => {
    setState([RUNTIME_PTY, OWNERLESS_RUNTIME_PTY])
    answerWith({ [RUNTIME_PTY]: BUSY, [OWNERLESS_RUNTIME_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'none'
    })
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
  })

  it('still warns when closing the window over a live process on a paired runtime host', async () => {
    setState([RUNTIME_PTY])
    answerWith({ [RUNTIME_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'running'
    })
  })

  // Unreachable remote work is unverifiable, never proof of exit; quitting silently could orphan it.
  it('warns rather than quitting silently when a remote host answers unverifiable', async () => {
    setState([SSH_PTY])
    answerWith({ [SSH_PTY]: UNVERIFIABLE })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'unverifiable'
    })
  })

  it('reports a live process even when a sibling remote pane is only unverifiable', async () => {
    setState([SSH_PTY, RUNTIME_PTY])
    answerWith({ [SSH_PTY]: UNVERIFIABLE, [RUNTIME_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'running'
    })
  })

  it('still warns about a live local process when closing the window', async () => {
    setState([LOCAL_PTY])
    answerWith({ [LOCAL_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'running'
    })
  })

  // Local probe failure has no lost-transport ambiguity and must not block closing.
  it('does not warn when only a local probe is unverifiable', async () => {
    setState([LOCAL_PTY])
    answerWith({ [LOCAL_PTY]: UNVERIFIABLE })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'none'
    })
  })

  // Quit consents to end this machine’s processes (#524); it does not consent to end remote work.
  it('leaves local-only quit unprompted, and never probes for it', async () => {
    setState([LOCAL_PTY])
    answerWith({ [LOCAL_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'none'
    })
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
  })
})
