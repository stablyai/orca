import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeHostConnection } from '@/lib/worktree-host-connection-phase'

const { getStateMock, inspectRuntimeTerminalProcessMock, hostByWorktreeId } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn(),
  hostByWorktreeId: new Map<string, Partial<WorktreeHostConnection>>()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

vi.mock('@/lib/worktree-host-connection-phase', () => ({
  selectWorktreeHostConnectionPhase: (_state: unknown, worktreeId: string) => ({
    phase: 'unavailable',
    targetId: null,
    environmentId: null,
    unavailableReason: null,
    ...hostByWorktreeId.get(worktreeId)
  })
}))

import {
  assessWindowCloseRunningWork,
  WINDOW_CLOSE_PROBE_TIMEOUT_MS
} from './window-close-running-work'

const LOCAL_PTY = 'pty-local'
const SSH_PTY = 'ssh:openclaw@@pty-7'
const OTHER_SSH_PTY = 'ssh:buildbox@@pty-3'
const RUNTIME_PTY = 'remote:env-1@@handle-1'
/** A runtime pty minted without an owner id. Still someone else's machine. */
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

/** One worktree, one tab, owning `ptyIds`. */
function setState(ptyIds: string[]): void {
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
    ptyIdsByTabId: { 'tab-1': ptyIds },
    terminalLayoutsByTabId: {}
  })
}

/** Two SSH worktrees, one pty each, with `worktree-a` on a host the user disconnected. */
function setTwoHostState(): void {
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'worktree-a': [{ id: 'tab-a' }], 'worktree-b': [{ id: 'tab-b' }] },
    ptyIdsByTabId: { 'tab-a': [SSH_PTY], 'tab-b': [OTHER_SSH_PTY] },
    terminalLayoutsByTabId: {},
    sshTargetLabels: new Map([['ssh-a', 'devbox']])
  })
  hostByWorktreeId.set('worktree-a', {
    targetId: 'ssh-a',
    unavailableReason: 'user-disconnected'
  })
}

/** Answers each pty id from `byPtyId`; anything unlisted never settles. */
function answerWith(byPtyId: Record<string, unknown>): void {
  inspectRuntimeTerminalProcessMock.mockImplementation((_settings: unknown, ptyId: string) =>
    ptyId in byPtyId ? Promise.resolve(byPtyId[ptyId]) : new Promise(() => {})
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  hostByWorktreeId.clear()
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

  it('warns on quit about a live process on an SSH host', async () => {
    setState([SSH_PTY])
    answerWith({ [SSH_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'running'
    })
  })

  it('warns on quit about a live process on a paired runtime host', async () => {
    setState([RUNTIME_PTY])
    answerWith({ [RUNTIME_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'running'
    })
  })

  it('counts an owner-less remote pty as remote work', async () => {
    setState([OWNERLESS_RUNTIME_PTY])
    answerWith({ [OWNERLESS_RUNTIME_PTY]: BUSY })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'running'
    })
  })

  // The crux of docs/reference/ssh-execution-boundary.md: an unreachable host is `unverifiable`,
  // and quitting on `unverifiable` as though it were `exited` is what orphans live remote work.
  it('warns rather than quitting silently when a remote host answers unverifiable', async () => {
    setState([SSH_PTY])
    answerWith({ [SSH_PTY]: UNVERIFIABLE })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'unverifiable',
      userDisconnectedHostLabels: []
    })
  })

  it('names a host the user disconnected instead of calling it unreachable', async () => {
    setTwoHostState()
    answerWith({ [SSH_PTY]: UNVERIFIABLE, [OTHER_SSH_PTY]: IDLE })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'user-disconnected',
      hostLabels: ['devbox']
    })
  })

  it('still reports an unreachable host beside one the user disconnected', async () => {
    setTwoHostState()
    answerWith({ [SSH_PTY]: UNVERIFIABLE, [OTHER_SSH_PTY]: UNVERIFIABLE })

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'unverifiable',
      userDisconnectedHostLabels: ['devbox']
    })
  })

  it('warns rather than quitting silently when a remote probe throws', async () => {
    setState([SSH_PTY])
    inspectRuntimeTerminalProcessMock.mockRejectedValue(new Error('relay wedged'))

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
      kind: 'unverifiable',
      userDisconnectedHostLabels: []
    })
  })

  it('stops waiting at the budget and warns, so an unreachable host cannot hang the quit', async () => {
    setState([SSH_PTY])
    answerWith({})
    vi.useFakeTimers()

    const pending = assessWindowCloseRunningWork({ isQuitting: true })
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_PROBE_TIMEOUT_MS)

    await expect(pending).resolves.toEqual({ kind: 'unverifiable', userDisconnectedHostLabels: [] })
  })

  it('does not resolve before the budget expires', async () => {
    setState([SSH_PTY])
    answerWith({})
    vi.useFakeTimers()
    const settled = vi.fn()

    void assessWindowCloseRunningWork({ isQuitting: true }).then(settled)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_PROBE_TIMEOUT_MS - 1)

    expect(settled).not.toHaveBeenCalled()
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

    await expect(assessWindowCloseRunningWork({ isQuitting: true })).resolves.toEqual({
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

  // A local probe has no transport to lose, so its failure means the pty is gone — unlike a
  // remote host going quiet, it is not a reason to hold up the close.
  it('does not warn when only a local probe is unverifiable', async () => {
    setState([LOCAL_PTY])
    answerWith({ [LOCAL_PTY]: UNVERIFIABLE })

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'none'
    })
  })

  // #524 decided quitting is an unambiguous instruction to end this machine's processes. It is
  // not an instruction to end execution on someone else's, which is why remote still warns above.
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

  it('closes without probing when no workspace owns a pty', async () => {
    setState([])

    await expect(assessWindowCloseRunningWork({ isQuitting: false })).resolves.toEqual({
      kind: 'none'
    })
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
  })
})
