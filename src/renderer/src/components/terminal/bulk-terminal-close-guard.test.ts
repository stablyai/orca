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
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'
import { collectBulkTerminalTabIds, guardBulkTerminalClose } from './bulk-terminal-close-guard'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

const TERMINAL_TABS = [
  { id: 'unified-a', entityId: 'tab-a', contentType: 'terminal', label: 'npm run dev' },
  { id: 'unified-b', entityId: 'tab-b', contentType: 'terminal', label: 'pytest' }
]

function setState(overrides: Record<string, unknown> = {}): void {
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'] },
    terminalLayoutsByTabId: {
      'tab-a': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } },
      'tab-b': { ptyIdsByLeafId: { [LEAF_B]: 'pty-b' } }
    },
    unifiedTabsByWorktree: { 'wt-1': TERMINAL_TABS },
    tabsByWorktree: { 'wt-1': [{ id: 'tab-a' }, { id: 'tab-b' }] },
    agentStatusByPaneKey: {},
    ...overrides
  })
}

function guard(
  overrides: {
    onProceed?: () => void
    onCancel?: () => void
    revealTab?: (terminalTabId: string) => void
  } = {}
): void {
  guardBulkTerminalClose({
    worktreeId: 'wt-1',
    terminalTabIds: ['tab-a', 'tab-b'],
    onProceed: overrides.onProceed ?? vi.fn(),
    ...(overrides.onCancel ? { onCancel: overrides.onCancel } : {}),
    ...(overrides.revealTab ? { revealTab: overrides.revealTab } : {})
  })
}

function visibleRequest() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

function confirmVisible(): void {
  useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
}

/** The store ignores an action landing within 350ms of a prompt being replaced in place. */
function advancePastStrayActionGuard(): void {
  vi.advanceTimersByTime(400)
}

async function settleProbe(): Promise<void> {
  // Why: allSettled plus the guard's own then/catch chain take several microtask turns; an
  // under-drained probe would resolve during the *next* test and pollute its prompt queue.
  for (let tick = 0; tick < 12; tick += 1) {
    await Promise.resolve()
  }
}

describe('collectBulkTerminalTabIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setState()
  })

  it('accepts unified ids and entity ids, and skips non-terminal and pinned tabs', () => {
    setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          { id: 'unified-a', entityId: 'tab-a', contentType: 'terminal' },
          { id: 'unified-b', entityId: 'tab-b', contentType: 'terminal', isPinned: true },
          { id: 'unified-c', entityId: 'file-c', contentType: 'editor' }
        ]
      }
    })

    expect(
      collectBulkTerminalTabIds(getStateMock(), 'wt-1', ['unified-a', 'tab-b', 'unified-c'])
    ).toEqual(['tab-a'])
  })

  it('falls back to the runtime tab store for a terminal with no unified row yet', () => {
    setState({ unifiedTabsByWorktree: { 'wt-1': [] } })

    expect(collectBulkTerminalTabIds(getStateMock(), 'wt-1', ['tab-a', 'unknown'])).toEqual([
      'tab-a'
    ])
  })
})

/** Monotonic per-test clock; see the stray-action guard note in beforeEach. */
let testClock = Date.UTC(2026, 0, 1)

describe('guardBulkTerminalClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Why: the store's stray-action guard keys off Date.now(), so the sequential prompts
    // need a clock the test can move rather than real 350ms sleeps.
    vi.useFakeTimers()
    // Why: that guard is module state keyed to Date.now(), and every fake clock restarts at
    // the same real time — so each test needs a clock strictly ahead of whatever the
    // previous one armed, or its very first confirm is silently swallowed.
    testClock += 60 * 60 * 1000
    vi.setSystemTime(testClock)
    // Why: the pending-request queue is closure state that setState cannot reach, so drain
    // it or a leftover request takes the visible slot mid-sequence in this test.
    useRunningTerminalCloseConfirmStore.getState().confirmAllRunningTerminalCloses()
    setState()
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: false,
      unavailable: false
    })
    useRunningTerminalCloseConfirmStore.setState({ runningTerminalCloseConfirm: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('proceeds synchronously when no tab in the set has a live pty', () => {
    setState({ ptyIdsByTabId: {}, terminalLayoutsByTabId: {} })
    const onProceed = vi.fn()

    guard({ onProceed })

    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
    expect(visibleRequest()).toBeNull()
  })

  it('proceeds synchronously when the user opted out of the prompt', () => {
    setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        skipCloseTerminalWithRunningProcessConfirm: true
      }
    })
    const onProceed = vi.fn()

    guard({ onProceed })

    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
  })

  it('proceeds without asking when every probe reports an idle shell', async () => {
    const onProceed = vi.fn()

    guard({ onProceed })
    await settleProbe()

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledTimes(2)
    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('asks about one busy tab at a time and closes only after the last answer', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })
    const onProceed = vi.fn()

    guard({ onProceed })
    await settleProbe()

    expect(visibleRequest()?.terminalTabId).toBe('tab-a')
    expect(visibleRequest()?.tabLabel).toBe('npm run dev')
    expect(onProceed).not.toHaveBeenCalled()

    confirmVisible()

    // Why: still nothing closed — the second tab has not been answered yet.
    expect(onProceed).not.toHaveBeenCalled()
    expect(visibleRequest()?.terminalTabId).toBe('tab-b')
    expect(visibleRequest()?.tabLabel).toBe('pytest')

    advancePastStrayActionGuard()
    confirmVisible()

    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('reveals each busy tab before raising its prompt', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })
    const revealed: string[] = []
    const revealTab = vi.fn((terminalTabId: string) => {
      // Why: read the visible prompt strictly before this tab's own opens, so a reveal that
      // lands after the dialog would fail here instead of silently passing.
      expect(visibleRequest()?.terminalTabId).not.toBe(terminalTabId)
      revealed.push(terminalTabId)
    })

    guard({ revealTab })
    await settleProbe()
    confirmVisible()
    advancePastStrayActionGuard()
    confirmVisible()

    expect(revealed).toEqual(['tab-a', 'tab-b'])
  })

  it('only asks about the tabs that reported a live child', async () => {
    inspectRuntimeTerminalProcessMock.mockImplementation((_settings, ptyId: string) =>
      Promise.resolve({ hasChildProcesses: ptyId === 'pty-b', unavailable: false })
    )
    const onProceed = vi.fn()

    guard({ onProceed })
    await settleProbe()

    expect(visibleRequest()?.terminalTabId).toBe('tab-b')

    confirmVisible()

    expect(onProceed).toHaveBeenCalledTimes(1)
  })

  it('cancelling one prompt abandons the whole bulk close', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })
    const onProceed = vi.fn()
    const onCancel = vi.fn()

    guard({ onProceed, onCancel })
    await settleProbe()
    confirmVisible()
    expect(visibleRequest()?.terminalTabId).toBe('tab-b')

    advancePastStrayActionGuard()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()

    // Why: the already-approved tab must not close either — a half-applied bulk close is
    // exactly what cancel has to prevent.
    expect(onProceed).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('stops asking about the rest of the set once the user opts out', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })
    const onProceed = vi.fn()

    guard({ onProceed })
    await settleProbe()
    useRunningTerminalCloseConfirmStore.getState().confirmAllRunningTerminalCloses()

    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('skips a queued tab that exited while an earlier prompt was open', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })
    const onProceed = vi.fn()

    guard({ onProceed })
    await settleProbe()
    expect(visibleRequest()?.terminalTabId).toBe('tab-a')
    setState({
      unifiedTabsByWorktree: { 'wt-1': [TERMINAL_TABS[0]!] },
      tabsByWorktree: { 'wt-1': [{ id: 'tab-a' }] }
    })

    confirmVisible()

    expect(visibleRequest()).toBeNull()
    expect(onProceed).toHaveBeenCalledTimes(1)
  })

  it('words the prompt for an agent pane', async () => {
    setState({
      agentStatusByPaneKey: { [`tab-b:${LEAF_B}`]: { agentType: 'claude' } }
    })
    inspectRuntimeTerminalProcessMock.mockImplementation((_settings, ptyId: string) =>
      Promise.resolve({ hasChildProcesses: ptyId === 'pty-b', unavailable: false })
    )

    guard()
    await settleProbe()

    expect(visibleRequest()?.copyKind).toBe('agent')
  })

  it('proceeds on an answered probe that could not inspect the shell', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: true
    })
    const onProceed = vi.fn()

    guard({ onProceed })
    await settleProbe()

    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('asks rather than closes when the probe never answers', async () => {
    inspectRuntimeTerminalProcessMock.mockReturnValue(new Promise(() => {}))
    const onProceed = vi.fn()

    guard({ onProceed })
    vi.advanceTimersByTime(RUNNING_CLOSE_PROBE_TIMEOUT_MS)

    expect(onProceed).not.toHaveBeenCalled()
    expect(visibleRequest()?.terminalTabId).toBe('tab-a')
  })

  it('guards the next prompt against a stray action meant for the previous one', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })
    const onProceed = vi.fn()

    guard({ onProceed })
    await settleProbe()
    confirmVisible()

    // Why: a held Enter or double-click aimed at tab-a's prompt must not also answer
    // tab-b's, which replaced it in place.
    confirmVisible()

    expect(visibleRequest()?.terminalTabId).toBe('tab-b')
    expect(onProceed).not.toHaveBeenCalled()
  })
})
