import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  RUNTIME_EXECUTION_HOST_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    return () => {}
  },
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

const FOLDER_WORKSPACE_ID = 'folder:fw-1'

type MutableSelection = {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}

/**
 * The harness stub answers with a frozen object; the latch these tests are about
 * only shows up when `setActiveWorktree` actually moves what the next read sees.
 */
function stubSelectableWorkspaceStore(selection: MutableSelection): void {
  const base = mocks.getState() as Record<string, unknown>
  mocks.getState.mockImplementation(() => ({ ...base, ...selection }))
  mocks.setActiveWorktree.mockImplementation(
    (worktreeId: string | null, executionHostId?: ExecutionHostId) => {
      selection.activeWorktreeId = worktreeId
      selection.activeWorkspaceExecutionHostId = executionHostId ?? null
      return true
    }
  )
}

afterEach(() => resetWebSessionCloseIntentForTests())

describe('web-runtime-session terminal workspace routing', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it('does not route a locally-owned workspace to the focused runtime environment', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    // `environmentId: null` is the caller saying "I resolved ownership: nobody remote owns this".
    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: null,
      command: 'powershell.exe',
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(selection).toEqual({
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    })
  })

  it('does not route a locally-owned folder workspace to the focused runtime environment', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: FOLDER_WORKSPACE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: FOLDER_WORKSPACE_ID,
      environmentId: null,
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(selection.activeWorkspaceExecutionHostId).toBe('local')
  })

  it('still falls back to the focused environment when the caller expressed no ownership', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: RUNTIME_EXECUTION_HOST_ID
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { tab: { id: 'host-tab-1' }, publicationEpoch: 'epoch-1', snapshotVersion: 2 }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      activate: true
    })

    expect(outcome).toEqual({ status: 'created' })
    expect(runtimeCall.mock.calls[0][0]).toMatchObject({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.createTerminal'
    })
  })

  it('hands the workspace host selection back when the host never accepted the create', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn().mockRejectedValue(new Error('selector_not_found'))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(mocks.setActiveWorktree.mock.calls).toEqual([
      [WORKTREE_ID, RUNTIME_EXECUTION_HOST_ID],
      [WORKTREE_ID, 'local']
    ])
    // The latch is what silently reroutes the next Ctrl+T; it must not survive the failure.
    expect(selection).toEqual({
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    })
  })

  it('keeps the host selection after a create the host accepted', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { tab: { id: 'host-tab-1' }, publicationEpoch: 'epoch-1', snapshotVersion: 2 }
      })
      .mockRejectedValueOnce(new Error('list failed'))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(outcome).toEqual({ status: 'created' })
    expect(mocks.setActiveWorktree.mock.calls).toEqual([[WORKTREE_ID, RUNTIME_EXECUTION_HOST_ID]])
    expect(selection.activeWorkspaceExecutionHostId).toBe(RUNTIME_EXECUTION_HOST_ID)
  })

  it('leaves a selection the user moved during the failed create alone', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn().mockImplementation(async () => {
      // The user switched workspaces while the doomed create was in flight.
      selection.activeWorktreeId = 'repo::/other'
      selection.activeWorkspaceExecutionHostId = 'local'
      throw new Error('selector_not_found')
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(mocks.setActiveWorktree.mock.calls).toEqual([[WORKTREE_ID, RUNTIME_EXECUTION_HOST_ID]])
    expect(selection.activeWorktreeId).toBe('repo::/other')
  })

  it('does not touch the host selection when the caller opted out of selecting', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn().mockRejectedValue(new Error('selector_not_found'))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      selectWorktree: false,
      activate: true
    })

    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(selection.activeWorkspaceExecutionHostId).toBe('local')
  })
})
