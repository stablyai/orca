import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, inspectRuntimeTerminalProcessMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import {
  guardRunningTerminalClose,
  RUNNING_CLOSE_PROBE_TIMEOUT_MS
} from './running-terminal-close-guard'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function setState(overrides: Record<string, unknown> = {}): void {
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    ptyIdsByTabId: { 'tab-1': ['pty-a'] },
    terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } } },
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
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

// Flush generously: inspect, batch join, and deadline racing each add await boundaries.
async function settleProbe(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) {
    await Promise.resolve()
  }
}

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

  // Layout bindings precede ptyIdsByTabId during mount; probe both to avoid unprompted closes.
  it('prompts for a pane the layout has bound but the liveness map has not', async () => {
    setState({ ptyIdsByTabId: { 'tab-1': [] } })
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledWith('pty-a', {
      scanChildProcesses: true
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({ terminalTabId: 'tab-1' })
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

  // #33265: a host that cannot read its child processes must not let a close kill a running agent.
  it('prompts when the host cannot observe child processes', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: null,
      hasChildProcesses: false,
      childProcessEvidence: 'unverifiable'
    })
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(onClose).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({ terminalTabId: 'tab-1' })
  })

  it('prompts once for a split tab where only the second pane is busy', async () => {
    setState({
      ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-b'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' } }
      },
      agentStatusByPaneKey: acceptedAgentStatuses(
        Object.entries({
          [`tab-1:${LEAF_B}`]: {
            paneKey: `tab-1:${LEAF_B}`,
            agentType: 'claude',
            state: 'working',
            prompt: '',
            stateHistory: [],
            updatedAt: 0,
            stateStartedAt: 0
          }
        })
      )
    })
    inspectRuntimeTerminalProcessMock.mockImplementation(async (ptyId: string) => ({
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

  // A remote probe may take 15 seconds; the 4-second deadline must ask instead of killing uninspected work.
  it('prompts instead of closing when a wedged remote probe never settles', async () => {
    vi.useFakeTimers()
    inspectRuntimeTerminalProcessMock.mockReturnValue(new Promise(() => {}))
    const onClose = vi.fn()

    guard(onClose)
    expect(onClose).not.toHaveBeenCalled()

    vi.advanceTimersByTime(RUNNING_CLOSE_PROBE_TIMEOUT_MS)
    vi.useRealTimers()
    await settleProbe()

    expect(onClose).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({ terminalTabId: 'tab-1', tabLabel: 'npm run dev' })

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // After SSH drops liveness IDs, probe stale layout bindings and fail open on rejection so reconnecting tabs remain closable.
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
