import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, inspectRuntimeTerminalProcessMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import {
  guardRunningTerminalGroupClose,
  RUNNING_CLOSE_PROBE_TIMEOUT_MS
} from './running-terminal-close-guard'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const TERMINALS = [
  { terminalTabId: 'tab-1', tabLabel: 'Build' },
  { terminalTabId: 'tab-2', tabLabel: 'Agent' },
  { terminalTabId: 'tab-3', tabLabel: 'Shell' }
]

function setState(overrides: Record<string, unknown> = {}): void {
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    ptyIdsByTabId: { 'tab-1': ['pty-a'], 'tab-2': ['pty-b'], 'tab-3': ['pty-c'] },
    terminalLayoutsByTabId: {
      'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } },
      'tab-2': { ptyIdsByLeafId: { [LEAF_A]: 'pty-b' } },
      'tab-3': { ptyIdsByLeafId: { [LEAF_A]: 'pty-c' } }
    },
    agentStatusByPaneKey: { [`tab-2:${LEAF_A}`]: { agentType: 'claude' } },
    ...overrides
  })
}

function guard(onClose = vi.fn(), onCancel?: () => void): void {
  guardRunningTerminalGroupClose({
    subjectKey: 'tab-cluster:cluster-1',
    groupLabel: 'Development',
    terminals: TERMINALS,
    onClose,
    ...(onCancel ? { onCancel } : {})
  })
}

function visibleRequest() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

async function settleProbe(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setState()
  inspectRuntimeTerminalProcessMock.mockImplementation(async (_settings, ptyId: string) => ({
    foregroundProcess: ptyId === 'pty-c' ? 'zsh' : 'sleep',
    hasChildProcesses: ptyId !== 'pty-c'
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  const store = useRunningTerminalCloseConfirmStore.getState()
  while (visibleRequest()) {
    store.dismissRunningTerminalClose()
  }
})

describe('guardRunningTerminalGroupClose', () => {
  it('closes synchronously without probing when no member owns a pty', () => {
    setState({ ptyIdsByTabId: {}, terminalLayoutsByTabId: {} })
    const onClose = vi.fn()

    guard(onClose)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
    expect(visibleRequest()).toBeNull()
  })

  it('honors the running-terminal prompt opt-out synchronously for the whole group', () => {
    setState({ settings: { skipCloseTerminalWithRunningProcessConfirm: true } })
    const onClose = vi.fn()

    guard(onClose)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
    expect(visibleRequest()).toBeNull()
  })

  it('closes an entirely idle group without a prompt', async () => {
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

  it('lists only the two busy terminals in group order, preferring agent copy', async () => {
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(onClose).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({
      terminalTabId: 'tab-cluster:cluster-1',
      tabLabel: 'Development',
      copyKind: 'agent'
    })
    expect(visibleRequest()?.groupTerminals).toEqual([
      { ...TERMINALS[0], copyKind: 'command' },
      { ...TERMINALS[1], copyKind: 'agent' }
    ])
    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(visibleRequest()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses command copy when only a non-agent terminal is busy', async () => {
    inspectRuntimeTerminalProcessMock.mockImplementation(async (_settings, ptyId: string) => ({
      foregroundProcess: ptyId === 'pty-a' ? 'sleep' : 'zsh',
      hasChildProcesses: ptyId === 'pty-a'
    }))

    guardRunningTerminalGroupClose({
      subjectKey: 'tab-cluster:unnamed',
      groupLabel: '',
      terminals: TERMINALS,
      onClose: vi.fn()
    })
    await settleProbe()

    expect(visibleRequest()).toMatchObject({
      terminalTabId: 'tab-cluster:unnamed',
      tabLabel: '',
      copyKind: 'command',
      groupTerminals: [{ ...TERMINALS[0], copyKind: 'command' }]
    })
  })

  it('confirmation closes once even when the action is repeated', async () => {
    const onClose = vi.fn()
    guard(onClose)
    await settleProbe()

    const store = useRunningTerminalCloseConfirmStore.getState()
    store.confirmRunningTerminalClose()
    store.confirmRunningTerminalClose()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('cancelling keeps every member and calls onCancel once', async () => {
    const onClose = vi.fn()
    const onCancel = vi.fn()
    guard(onClose, onCancel)
    await settleProbe()

    const store = useRunningTerminalCloseConfirmStore.getState()
    store.dismissRunningTerminalClose()
    store.dismissRunningTerminalClose()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(visibleRequest()).toBeNull()
  })

  it('lists a timed-out terminal without treating answered idle terminals as busy', async () => {
    vi.useFakeTimers()
    inspectRuntimeTerminalProcessMock.mockImplementation((_settings, ptyId: string) =>
      ptyId === 'pty-b'
        ? Promise.withResolvers().promise
        : Promise.resolve({ foregroundProcess: 'zsh', hasChildProcesses: false })
    )
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()
    await vi.advanceTimersByTimeAsync(RUNNING_CLOSE_PROBE_TIMEOUT_MS)

    expect(onClose).not.toHaveBeenCalled()
    expect(visibleRequest()?.groupTerminals).toEqual([{ ...TERMINALS[1], copyKind: 'agent' }])
  })

  it('does not let an answered idle agent pane change a timed-out sibling pane copy', async () => {
    setState({
      ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-agent'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-agent' } }
      },
      agentStatusByPaneKey: { [`tab-1:${LEAF_B}`]: { agentType: 'claude' } }
    })
    vi.useFakeTimers()
    inspectRuntimeTerminalProcessMock.mockImplementation((_settings, ptyId: string) =>
      ptyId === 'pty-a'
        ? Promise.withResolvers().promise
        : Promise.resolve({ foregroundProcess: 'zsh', hasChildProcesses: false })
    )

    guard()
    await settleProbe()
    await vi.advanceTimersByTimeAsync(RUNNING_CLOSE_PROBE_TIMEOUT_MS)

    expect(visibleRequest()).toMatchObject({ copyKind: 'command' })
    expect(visibleRequest()?.groupTerminals).toEqual([{ ...TERMINALS[0], copyKind: 'command' }])
  })

  it('closes when every probe answers with non-live evidence', async () => {
    inspectRuntimeTerminalProcessMock.mockRejectedValue(new Error('ssh_disconnected'))
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('falls through to one close if raising the group confirmation throws', async () => {
    vi.spyOn(
      useRunningTerminalCloseConfirmStore.getState(),
      'requestRunningTerminalCloseConfirm'
    ).mockImplementation(() => {
      throw new Error('subscriber failed')
    })
    const onClose = vi.fn()

    guard(onClose)
    await settleProbe()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('ignores a late busy answer after the timed-out group request was cancelled', async () => {
    const inspection = Promise.withResolvers<{ hasChildProcesses: boolean }>()
    inspectRuntimeTerminalProcessMock.mockImplementation((_settings, ptyId: string) =>
      ptyId === 'pty-a'
        ? inspection.promise
        : Promise.resolve({ foregroundProcess: 'zsh', hasChildProcesses: false })
    )
    vi.useFakeTimers()
    const onClose = vi.fn()
    const onCancel = vi.fn()

    guard(onClose, onCancel)
    await settleProbe()
    await vi.advanceTimersByTimeAsync(RUNNING_CLOSE_PROBE_TIMEOUT_MS)
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    inspection.resolve({ hasChildProcesses: true })
    await settleProbe()

    expect(onClose).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })
})
