import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, inspectRuntimeTerminalProcessMock, admitStructuredAgentSessionMock } =
  vi.hoisted(() => ({
    getStateMock: vi.fn(),
    inspectRuntimeTerminalProcessMock: vi.fn(),
    admitStructuredAgentSessionMock: vi.fn()
  }))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

vi.mock('@/lib/agent-session/structured-agent-session-busy', () => ({
  admitStructuredAgentSession: admitStructuredAgentSessionMock
}))

import {
  assessWindowCloseRunningWork,
  WINDOW_CLOSE_PROBE_TIMEOUT_MS
} from './window-close-running-work'

const LOCAL_PTY = 'pty-local'
const SSH_PTY = 'ssh:openclaw@@pty-7'
const RUNTIME_PTY = 'remote:env-1@@handle-1'
const OWNERLESS_RUNTIME_PTY = 'remote:handle-2'

const BUSY = {
  foregroundProcess: 'pnpm build',
  hasChildProcesses: true,
  foregroundProcessEvidence: {}
}
const IDLE = { foregroundProcess: 'bash', hasChildProcesses: false, foregroundProcessEvidence: {} }
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
    terminalLayoutsByTabId: {}
  })
}

function answerWith(byPtyId: Record<string, unknown>): void {
  inspectRuntimeTerminalProcessMock.mockImplementation((ptyId: string) =>
    ptyId in byPtyId ? Promise.resolve(byPtyId[ptyId]) : new Promise(() => {})
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  admitStructuredAgentSessionMock.mockImplementation((_workspace, _tab, _intent, effect) => {
    effect(false, {
      current: () => true,
      busy: () => false,
      signal: new AbortController().signal
    })
    return Promise.resolve()
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('assessWindowCloseRunningWork', () => {
  it('warns about a live process on an SSH host (F15: remote work was filtered out entirely)', async () => {
    setState([SSH_PTY])
    answerWith({ [SSH_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'running'
    })
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

  it('still warns when closing the window over an owner-less runtime pty', async () => {
    setState([OWNERLESS_RUNTIME_PTY])
    answerWith({ [OWNERLESS_RUNTIME_PTY]: UNVERIFIABLE })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'unverifiable'
    })
  })

  it('warns on quit about an SSH relay pty alongside a busy paired runtime pty', async () => {
    setState([SSH_PTY, RUNTIME_PTY])
    answerWith({ [SSH_PTY]: BUSY, [RUNTIME_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'running'
    })
    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledTimes(1)
  })

  // Unreachable remote work is unverifiable, never proof of exit; quitting silently could orphan it.
  it('warns rather than quitting silently when a remote host answers unverifiable', async () => {
    setState([SSH_PTY])
    answerWith({ [SSH_PTY]: UNVERIFIABLE })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'unverifiable'
    })
  })

  it('warns rather than quitting silently when a remote probe throws', async () => {
    setState([SSH_PTY])
    inspectRuntimeTerminalProcessMock.mockRejectedValue(new Error('relay wedged'))

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'unverifiable'
    })
  })

  it('stops waiting at the budget and warns, so an unreachable host cannot hang the quit', async () => {
    setState([SSH_PTY])
    answerWith({})
    vi.useFakeTimers()

    const pending = assessWindowCloseRunningWork({ isQuitting: true })
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_PROBE_TIMEOUT_MS)

    await expect(pending).resolves.toEqual({ kind: 'unverifiable' })
  })

  it('does not warn when the owning remote host reports an idle shell', async () => {
    setState([SSH_PTY])
    answerWith({ [SSH_PTY]: IDLE })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'none'
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

  it('probes a pane the layout has bound before the liveness map caught up', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { leaf: SSH_PTY } } }
    })
    answerWith({ [SSH_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'running'
    })
  })

  it('probes each pty once when the map and the layout name the same one', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
      ptyIdsByTabId: { 'tab-1': [SSH_PTY] },
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { leaf: SSH_PTY } } }
    })
    answerWith({ [SSH_PTY]: IDLE })

    await assessWindowCloseRunningWork({ isQuitting: true })

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledTimes(1)
  })

  it('warns with kind chat when an agent session in unifiedTabsByWorktree is busy', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'agent-1',
            entityId: 'session-1',
            contentType: 'agent-session'
          }
        ]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })
    admitStructuredAgentSessionMock.mockImplementation((_ws, _tab, _intent, effect) => {
      effect(true, {
        current: () => true,
        busy: () => true,
        signal: new AbortController().signal
      })
      return Promise.resolve()
    })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'chat'
    })
  })

  it('does not warn for an agent session when it is idle', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'agent-1',
            entityId: 'session-1',
            contentType: 'agent-session'
          }
        ]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })
    admitStructuredAgentSessionMock.mockImplementation((_ws, _tab, _intent, effect) => {
      effect(false, {
        current: () => true,
        busy: () => false,
        signal: new AbortController().signal
      })
      return Promise.resolve()
    })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'none'
    })
  })

  it('probes unified terminal tabs and warns when a process is live', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-unified-1',
            entityId: 'term-1',
            contentType: 'terminal'
          }
        ]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: { 'term-1': [LOCAL_PTY] },
      terminalLayoutsByTabId: {}
    })
    answerWith({ [LOCAL_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'running'
    })
  })

  it('warns with kind pinned when pinned tabs exist in unifiedTabsByWorktree', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab: true },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-pinned-1',
            entityId: 'editor-1',
            contentType: 'editor',
            isPinned: true
          }
        ]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'pinned'
    })
  })

  it('does not warn for pinned tabs when confirmClosePinnedTab is false', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab: false },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-pinned-1',
            entityId: 'editor-1',
            contentType: 'editor',
            isPinned: true
          }
        ]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'none'
    })
  })

  it('skips chat and terminal process confirmation when skipCloseTerminalWithRunningProcessConfirm is true', async () => {
    getStateMock.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: null,
        skipCloseTerminalWithRunningProcessConfirm: true,
        confirmClosePinnedTab: false
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'agent-1',
            entityId: 'session-1',
            contentType: 'agent-session'
          }
        ]
      },
      tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
      ptyIdsByTabId: { 'tab-1': [LOCAL_PTY] },
      terminalLayoutsByTabId: {}
    })
    answerWith({ [LOCAL_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'none'
    })
    expect(admitStructuredAgentSessionMock).not.toHaveBeenCalled()
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
  })

  it('prioritizes busy chat over pinned tabs', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab: true },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'agent-1',
            entityId: 'session-1',
            contentType: 'agent-session'
          },
          {
            id: 'tab-pinned-1',
            entityId: 'editor-1',
            contentType: 'editor',
            isPinned: true
          }
        ]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })
    admitStructuredAgentSessionMock.mockImplementation((_ws, _tab, _intent, effect) => {
      effect(true, {
        current: () => true,
        busy: () => true,
        signal: new AbortController().signal
      })
      return Promise.resolve()
    })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'chat'
    })
  })
})
