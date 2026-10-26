// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneProcessExit } from './pty-connection-types'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

type MockState = {
  storeState: { tabsByWorktree: Record<string, unknown[]> }
  readyRestartPtyIds: string[]
  pendingAgent: 'codex' | 'claude' | null
}

const mocks = vi.hoisted(() => {
  const state: MockState = {
    storeState: { tabsByWorktree: {} },
    readyRestartPtyIds: [],
    pendingAgent: null
  }
  return {
    ...state,
    connectPanePty: vi.fn(() => ({ dispose: vi.fn() })),
    buildPaneAccountRestartStartup: vi.fn((agent: string) => ({
      command: `${agent} resume session-1`
    }))
  }
})

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(mocks.storeState),
    { getState: () => mocks.storeState }
  )
}))
vi.mock('./pty-connection', () => ({ connectPanePty: mocks.connectPanePty }))
vi.mock('@/lib/agent-account-restart-startup', () => ({
  buildPaneAccountRestartStartup: mocks.buildPaneAccountRestartStartup
}))
vi.mock('./pane-account-restart-readiness', () => ({
  selectReadyAccountRestartPtyIds: () => mocks.readyRestartPtyIds,
  isAccountRestartReady: () => true
}))

import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'

const PANE = { id: 1, leafId: '11111111-1111-4111-8111-111111111111', container: { dataset: {} } }

function createController(): TerminalPaneCloseController {
  const manager = { getPanes: () => [PANE], setActivePane: vi.fn() }
  const transport = { getPtyId: () => 'pty-1', destroy: vi.fn() }
  const members = new Map<PropertyKey, unknown>(
    Object.entries({
      managerRef: { current: manager },
      paneTransportsRef: { current: new Map([[PANE.id, transport]]) },
      panePtyBindingsRef: { current: new Map() },
      savedLayout: { ptyIdsByLeafId: { [PANE.leafId]: 'pty-1' } },
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      consumePendingPaneAccountRestart: () => mocks.pendingAgent,
      setPaneProcessExitsByPaneId: vi.fn(),
      setTerminalErrorsByPaneId: vi.fn()
    })
  )
  // Why: every other controller member is a no-op callback for these restart paths.
  const noop = vi.fn()
  const stub = new Proxy({}, { get: (_, key) => (members.has(key) ? members.get(key) : noop) })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only reads the members stubbed above plus callbacks the proxy fills with no-ops.
  return stub as unknown as TerminalPaneCloseController
}

describe('useTerminalPaneProcessExitActions', () => {
  beforeEach(() => {
    mocks.readyRestartPtyIds = []
    mocks.pendingAgent = null
    mocks.connectPanePty.mockClear()
    mocks.buildPaneAccountRestartStartup.mockClear()
  })

  it('restarts a failed shell as a plain shell, not an agent', () => {
    const { result } = renderHook(() => useTerminalPaneProcessExitActions(createController()))
    const processExit: PaneProcessExit = {
      paneId: PANE.id,
      exitCode: 1,
      reason: 'process-failed',
      startup: null
    }

    act(() => result.current.handleRestartExitedPane(processExit))

    expect(mocks.connectPanePty).toHaveBeenCalledTimes(1)
    expect(mocks.connectPanePty).toHaveBeenCalledWith(
      PANE,
      expect.anything(),
      expect.objectContaining({ startup: null })
    )
    expect(mocks.buildPaneAccountRestartStartup).not.toHaveBeenCalled()
  })

  it('still resumes Codex when an account switch restarts the pane', () => {
    mocks.readyRestartPtyIds = ['pty-1']
    mocks.pendingAgent = 'codex'

    renderHook(() => useTerminalPaneProcessExitActions(createController()))

    expect(mocks.buildPaneAccountRestartStartup).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ leafId: PANE.leafId })
    )
    expect(mocks.connectPanePty).toHaveBeenCalledWith(
      PANE,
      expect.anything(),
      expect.objectContaining({ startup: { command: 'codex resume session-1' } })
    )
  })
})
