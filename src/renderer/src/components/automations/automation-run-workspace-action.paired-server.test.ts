/**
 * A run that executed on a paired server (#21213) names the server's tab, pane and PTY. This client
 * shows that pane as a mirrored tab keyed by the server's terminal handle, so matching the server's
 * PTY id against local state always failed and the run read "Run terminal is unavailable.".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return {
    state,
    toastError: vi.fn(),
    toastMessage: vi.fn(),
    activateAndRevealWorktree: vi.fn(() => true),
    activateWebRuntimeSessionTab: vi.fn(async () => true),
    activateTerminalTabOnOwner: vi.fn()
  }
})

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: mocks.toastMessage } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: mocks.activateWebRuntimeSessionTab
}))
vi.mock('@/lib/terminal-tab-owner-activation', () => ({
  activateTerminalTabOnOwner: mocks.activateTerminalTabOnOwner
}))

import { createAutomationRunWorkspaceAction } from './automation-run-workspace-action'
import type { AutomationsPageActionContext } from './automations-page-action-context'

const ENV = 'env-a'
const WT = 'repo-a::/srv/app'
const LEAF = '11111111-1111-4111-8111-111111111111'
const HOST_TAB = 'host-tab-1'
const MIRRORED_TAB = toWebTerminalSurfaceTabId(HOST_TAB)
const MIRRORED_PTY = toRemoteRuntimePtyId('term-handle-1', ENV)
const worktree = { id: WT, repoId: 'repo-a', hostId: `runtime:${ENV}` as const }

const run: AutomationRun = {
  id: 'run-1',
  automationId: 'automation-1',
  title: 'Run 1',
  scheduledFor: 1,
  status: 'completed',
  trigger: 'manual',
  workspaceId: WT,
  workspaceDisplayName: 'app',
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: HOST_TAB,
  terminalPaneKey: `${HOST_TAB}:${LEAF}`,
  // The server's own PTY id, which this client never sees.
  terminalPtyId: 'pty-on-server-7',
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: 1,
  dispatchedAt: 1,
  createdAt: 1
}

function storeState(mirrored: boolean): Record<string, unknown> {
  return {
    // Focus is on this computer: owner routing must not depend on it.
    settings: { activeRuntimeEnvironmentId: null },
    activeWorktreeId: null,
    repos: [{ id: 'repo-a', executionHostId: `runtime:${ENV}` }],
    worktreesByRepo: { 'repo-a': [{ ...worktree, runtimeOwnerEnvironmentId: ENV }] },
    getTab: (tabId: string) => (mirrored && tabId === MIRRORED_TAB ? { id: tabId } : undefined),
    terminalLayoutsByTabId: mirrored
      ? {
          [MIRRORED_TAB]: {
            root: { type: 'leaf', leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF]: MIRRORED_PTY }
          }
        }
      : {},
    ptyIdsByTabId: mirrored ? { [MIRRORED_TAB]: [MIRRORED_PTY] } : {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    setTabLayout: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn()
  }
}

function openRun(): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the action reads only these members.
  const context = {
    store: { repoForRow: () => undefined, worktreeForRow: () => worktree },
    list: { selectedRow: { key: 'row' } }
  } as unknown as AutomationsPageActionContext
  createAutomationRunWorkspaceAction(context)(run)
}

describe('opening a paired-server automation run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the mirrored pane of the run', () => {
    mocks.state = storeState(true)

    openRun()

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.state.setActiveTab).toHaveBeenCalledWith(MIRRORED_TAB)
    expect(mocks.activateTerminalTabOnOwner).toHaveBeenCalledWith(WT, MIRRORED_TAB, LEAF)
  })

  it('asks the server to open the pane when the mirror has not loaded it yet', async () => {
    mocks.state = storeState(false)

    openRun()
    await vi.waitFor(() => expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalled())

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(WT)
    expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WT, tabId: HOST_TAB, environmentId: ENV, leafId: LEAF })
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('says the terminal is unavailable only when the server has no such pane', async () => {
    mocks.state = storeState(false)
    mocks.activateWebRuntimeSessionTab.mockResolvedValueOnce(false)

    openRun()

    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Run terminal is unavailable.')
    )
  })
})
