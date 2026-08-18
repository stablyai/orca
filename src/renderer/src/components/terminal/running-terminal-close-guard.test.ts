import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, inspectRuntimeTerminalProcessMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import {
  guardRunningTerminalClose,
  shouldConfirmRunningTerminalClose,
  RUNNING_CLOSE_PROBE_TIMEOUT_MS
} from './running-terminal-close-guard'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function setState(overrides: Record<string, unknown> = {}): void {
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    ptyIdsByTabId: { 'tab-1': ['pty-a'] },
    terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } } },
    agentStatusByPaneKey: {},
    ...overrides
  })
}

function guard(onClose = vi.fn(), onCancel?: () => void): void {
  guardRunningTerminalClose({
    terminalTabId: 'tab-1',
    tabLabel: 'npm run dev',
    onClose,
    ...(onCancel ? { onCancel } : {})
  })
}

function visibleRequest() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

async function settleProbe(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('shouldConfirmRunningTerminalClose', () => {
  it('confirms a plain interactive close', () => {
    expect(shouldConfirmRunningTerminalClose(undefined)).toBe(true)
    expect(shouldConfirmRunningTerminalClose({})).toBe(true)
    expect(shouldConfirmRunningTerminalClose({ reason: 'user' })).toBe(true)
    expect(shouldConfirmRunningTerminalClose({ hostCloseReason: 'user' })).toBe(true)
  })

  it.each([
    ['post-confirmation re-entry', { force: true }],
    ['non-interactive CLI reject', { rejectPinned: true }],
    ['bulk/CLI opt-out', { skipRunningProcessConfirm: true }],
    ['pty lifecycle echo', { reason: 'pty-exit' as const }],
    ['cleanup teardown', { reason: 'cleanup' as const }],
    ['host-only pty lifecycle echo', { hostCloseReason: 'pty-exit' as const }],
    ['pty-scoped lifecycle close', { lifecyclePtyId: 'pty-a' }]
  ])('never prompts for a %s', (_label, options) => {
    expect(shouldConfirmRunningTerminalClose(options)).toBe(false)
  })
})

describe('guardRunningTerminalClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setState()
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'sleep',
      hasChildProcesses: true
    })
  })

  afterEach(() => {
    const store = useRunningTerminalCloseConfirmStore.getState()
    while (visibleRequest()) {
      store.dismissRunningTerminalClose()
    }
  })

  it('closes synchronously and never probes when the tab has no live pty', () => {
    setState({ ptyIdsByTabId: {}, terminalLayoutsByTabId: {} })
    const onClose = vi.fn()

    guard(onClose)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
  })

  // Why: a mounting pane is bound into the layout before ptyIdsByTabId catches up. Reading
  // only the liveness map would let a close slip through that window with no prompt.
  it('prompts for a pane the layout has bound but the liveness map has not', async () => {
    setState({ ptyIdsByTabId: { 'tab-1': [] } })
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledWith(expect.anything(), 'pty-a')
    expect(onClose).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({ terminalTabId: 'tab-1' })
  })

  it('probes each pty once when the map and the layout name the same one', async () => {
    guard()
    await settleProbe()

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledTimes(1)
  })

  it('closes without probing when the user turned the prompt off', () => {
    setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        skipCloseTerminalWithRunningProcessConfirm: true
      }
    })
    const onClose = vi.fn()

    guard(onClose)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
    expect(visibleRequest()).toBeNull()
  })

  it('closes an idle terminal without a prompt', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('defers a busy terminal behind a confirmation that carries the tab label', async () => {
    const onClose = vi.fn()

    guard(onClose)
    expect(onClose).not.toHaveBeenCalled()
    await settleProbe()

    expect(onClose).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({
      terminalTabId: 'tab-1',
      tabLabel: 'npm run dev',
      copyKind: 'command'
    })

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('runs onCancel and keeps the tab when the confirmation is dismissed', async () => {
    const onClose = vi.fn()
    const onCancel = vi.fn()

    guard(onClose, onCancel)
    await settleProbe()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('fails open and closes when the probe rejects (wedged relay / legacy provider)', async () => {
    inspectRuntimeTerminalProcessMock.mockRejectedValue(new Error('rpc_timeout'))
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('fails open when a remote handle reports the inspection as unavailable', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: null,
      hasChildProcesses: true,
      unavailable: true
    })
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('prompts once for a split tab where only the second pane is busy', async () => {
    setState({
      ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-b'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' } }
      },
      agentStatusByPaneKey: { [`tab-1:${LEAF_B}`]: { agentType: 'claude' } }
    })
    inspectRuntimeTerminalProcessMock.mockImplementation(async (_settings, ptyId: string) => ({
      foregroundProcess: ptyId === 'pty-b' ? 'claude' : 'zsh',
      hasChildProcesses: ptyId === 'pty-b'
    }))
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledTimes(2)
    expect(visibleRequest()).toMatchObject({ terminalTabId: 'tab-1', copyKind: 'agent' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not use an idle sibling pane to pick the agent copy', async () => {
    setState({
      ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-b'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' } }
      },
      agentStatusByPaneKey: { [`tab-1:${LEAF_B}`]: { agentType: 'claude' } }
    })
    inspectRuntimeTerminalProcessMock.mockImplementation(async (_settings, ptyId: string) => ({
      foregroundProcess: ptyId === 'pty-a' ? 'npm' : 'zsh',
      hasChildProcesses: ptyId === 'pty-a'
    }))

    guard()
    await settleProbe()

    expect(visibleRequest()?.copyKind).toBe('command')
  })

  it('prefers the agent copy regardless of pty spawn order when both panes are busy', async () => {
    setState({
      ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-b'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' } }
      },
      agentStatusByPaneKey: { [`tab-1:${LEAF_B}`]: { agentType: 'codex' } }
    })

    guard()
    await settleProbe()

    expect(visibleRequest()?.copyKind).toBe('agent')
  })

  it('ignores a pane whose agent status is unknown', async () => {
    setState({ agentStatusByPaneKey: { [`tab-1:${LEAF_A}`]: { agentType: 'unknown' } } })

    guard()
    await settleProbe()

    expect(visibleRequest()?.copyKind).toBe('command')
  })

  it('survives legacy layout leaf ids that are not stable pane uuids', async () => {
    setState({ terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { leaf: 'pty-a' } } } })
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(visibleRequest()).toMatchObject({ copyKind: 'command' })
    expect(onClose).not.toHaveBeenCalled()
  })

  // Why: makePaneKey throws on a tab id containing ':'; the dialog must never be the
  // reason a close silently stops happening.
  it('closes rather than wedging when the copy-kind lookup throws', async () => {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      ptyIdsByTabId: { 'tab:1': ['pty-a'] },
      terminalLayoutsByTabId: { 'tab:1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } } },
      agentStatusByPaneKey: {}
    })
    const onClose = vi.fn()

    guardRunningTerminalClose({ terminalTabId: 'tab:1', tabLabel: 'weird', onClose })
    await settleProbe()

    expect(visibleRequest()).toMatchObject({ terminalTabId: 'tab:1', copyKind: 'command' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes rather than wedging when raising the confirmation throws', async () => {
    const requestSpy = vi
      .spyOn(useRunningTerminalCloseConfirmStore.getState(), 'requestRunningTerminalCloseConfirm')
      .mockImplementation(() => {
        throw new Error('subscriber blew up')
      })
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()
    requestSpy.mockRestore()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Why: a remote inspect can take its full 15s RPC timeout. Closing at 4s would kill a
  // running remote command with no prompt — the exact failure this guard exists to stop.
  it('prompts instead of closing when a wedged remote probe never settles', async () => {
    vi.useFakeTimers()
    inspectRuntimeTerminalProcessMock.mockReturnValue(new Promise(() => {}))
    const onClose = vi.fn()

    guard(onClose)
    expect(onClose).not.toHaveBeenCalled()

    vi.advanceTimersByTime(RUNNING_CLOSE_PROBE_TIMEOUT_MS)
    vi.useRealTimers()

    expect(onClose).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({ terminalTabId: 'tab-1', tabLabel: 'npm run dev' })

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('treats every pane as a candidate when picking the copy for a timed-out probe', async () => {
    setState({
      ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-b'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' } }
      },
      agentStatusByPaneKey: { [`tab-1:${LEAF_B}`]: { agentType: 'claude' } }
    })
    vi.useFakeTimers()
    inspectRuntimeTerminalProcessMock.mockReturnValue(new Promise(() => {}))

    guard()
    vi.advanceTimersByTime(RUNNING_CLOSE_PROBE_TIMEOUT_MS)
    vi.useRealTimers()

    expect(visibleRequest()?.copyKind).toBe('agent')
  })

  it('closes rather than wedging when the timed-out prompt throws', async () => {
    const requestSpy = vi
      .spyOn(useRunningTerminalCloseConfirmStore.getState(), 'requestRunningTerminalCloseConfirm')
      .mockImplementation(() => {
        throw new Error('subscriber blew up')
      })
    vi.useFakeTimers()
    inspectRuntimeTerminalProcessMock.mockReturnValue(new Promise(() => {}))
    const onClose = vi.fn()

    guard(onClose)
    vi.advanceTimersByTime(RUNNING_CLOSE_PROBE_TIMEOUT_MS)
    vi.useRealTimers()
    requestSpy.mockRestore()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores a slow probe that resolves after the timeout already prompted', async () => {
    vi.useFakeTimers()
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'sleep',
      hasChildProcesses: true
    })
    const onClose = vi.fn()

    guard(onClose)
    vi.advanceTimersByTime(RUNNING_CLOSE_PROBE_TIMEOUT_MS)
    vi.useRealTimers()
    await settleProbe()

    expect(onClose).not.toHaveBeenCalled()
    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  // Why: an SSH drop zeroes ptyIdsByTabId while the layout still names the pane. The stale
  // binding is probed, that probe fails on the dead link, and the close falls open — so a
  // reconnecting tab stays closable instead of being blocked behind a prompt for a pty
  // nobody can reach. Documented so the behavior is a decision, not an accident.
  it('closes a reconnecting ssh tab whose pty ids were already zeroed', async () => {
    setState({ ptyIdsByTabId: { 'tab-1': [] } })
    inspectRuntimeTerminalProcessMock.mockRejectedValue(new Error('ssh_disconnected'))
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })
})
