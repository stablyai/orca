import { afterEach, describe, expect, it, vi } from 'vitest'
import './web-runtime-worktree-activation'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import './runtime-rpc-client'
import {
  confirmWebAgentSessionHandoffAfterCreate,
  isWebAgentSessionHandoffPostCreateSnapshotConfirmed,
  recordWebAgentSessionHandoff,
  resetWebAgentSessionHandoffsForTests
} from './web-agent-session-handoff'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import { ENVIRONMENT_ID, WORKTREE_ID, makeSnapshot } from './web-runtime-session-test-harness'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

const mocks = vi.hoisted(() => ({
  changedAgentPaneKeys: new Set<string>(),
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
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  runtimeEnvironmentIdOrLocalUnlessTwin: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn(),
  recoverWebSessionTerminalOrphansBeforeApply: vi.fn(
    async (_state: unknown, snapshot: unknown) => snapshot
  )
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync/tracking-lifecycle', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration
}))
vi.mock('./web-session-tabs-sync/snapshot-api', () => ({
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/tracking-decisions', () => ({
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: (
    buildPatch: (state: unknown, changedAgentPaneKeys: Set<string>) => unknown
  ) => {
    mocks.setState((state: unknown) => buildPatch(state, mocks.changedAgentPaneKeys))
    return () => {}
  }
}))
vi.mock('./web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverWebSessionTerminalOrphansBeforeApply
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: mocks.runtimeEnvironmentIdOrLocalUnlessTwin
}))

vi.mock('@/lib/agent-session/launch/prompt/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

afterEach(() => resetWebSessionCloseIntentForTests())

describe('refreshWebRuntimeSessionTabsSnapshot', () => {
  afterEach(() => {
    resetWebAgentSessionHandoffsForTests()
    replaceRuntimeEnvironmentRevisions([])
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('confirms only the exact handoff after its post-create list completes', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'list',
      ok: true,
      result: makeSnapshot()
    })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) =>
      updater({ state: 'before' })
    )
    mocks.applyWebSessionTabsSnapshot.mockImplementation((state) => state)
    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a'
    })
    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-b',
      hostTabId: 'host-b',
      hostTerminalHandle: 'term_host-b'
    })

    await refreshWebRuntimeSessionTabsSnapshot(ENVIRONMENT_ID, WORKTREE_ID, {
      acceptCurrentSnapshot: true,
      confirmAgentSessionHandoff: {
        provisionalTabId: 'provisional-a',
        hostTabId: 'host-a',
        hostTerminalHandle: 'term_host-a'
      }
    })

    const confirmed = (provisionalTabId: string): boolean =>
      isWebAgentSessionHandoffPostCreateSnapshotConfirmed({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        provisionalTabId
      })
    expect(confirmed('provisional-a')).toBe(true)
    expect(confirmed('provisional-b')).toBe(false)
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )

    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a-replacement'
    })
    confirmWebAgentSessionHandoffAfterCreate({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a'
    })
    expect(confirmed('provisional-a')).toBe(false)
  })
})
