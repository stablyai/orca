import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
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
import { guardRunningTerminalClose } from './running-terminal-close-guard'

const LEAF_A = '11111111-1111-4111-8111-111111111111'

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

  it('defers a busy terminal behind a confirmation until approved', async () => {
    const onClose = vi.fn()

    guard(onClose)
    expect(onClose).not.toHaveBeenCalled()
    await settleProbe()

    expect(onClose).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({
      terminalTabId: 'tab-1',
      copyKind: 'command'
    })

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(onClose).toHaveBeenCalledTimes(1)
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

  // A remote probe may take 15 seconds; the 4-second deadline must ask instead of killing uninspected work.

  // After SSH drops liveness IDs, probe stale layout bindings and fail open on rejection so reconnecting tabs remain closable.
})
