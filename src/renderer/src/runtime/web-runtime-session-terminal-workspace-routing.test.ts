import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  createWebRuntimeSessionTerminal,
  createWebRuntimeSessionTerminalForHost
} from './web-runtime-terminal-creation'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  RUNTIME_EXECUTION_HOST_ID,
  WORKTREE_ID,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'

import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

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
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync/tracking-lifecycle', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/snapshot-api', () => ({
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/tracking-decisions', () => ({
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    return () => {}
  }
}))
vi.mock('./web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

type MutableSelection = {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}

// Selection rollback requires a mutable harness store; frozen setActiveWorktree stubs mask the latch.
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

  it('does not fall back to the selected host when background recovery has lost its owner', async () => {
    const runtimeCall = vi.fn()
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    const outcome = await createWebRuntimeSessionTerminalForHost({
      worktreeId: WORKTREE_ID,
      environmentId: ' ',
      selectWorktree: false
    })

    expect(outcome.status).toBe('failed')
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('hands the workspace host selection back when the host never accepted the create', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn().mockRejectedValue(new Error('selector_not_found'))
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

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
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

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
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(mocks.setActiveWorktree.mock.calls).toEqual([[WORKTREE_ID, RUNTIME_EXECUTION_HOST_ID]])
    expect(selection.activeWorktreeId).toBe('repo::/other')
  })
})
