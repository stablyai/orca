import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
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
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
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
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration,
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

const MINTED_GROUP_ID = 'group-right-minted'

function group(id: string) {
  return { id, worktreeId: WORKTREE_ID, activeTabId: null, tabOrder: [] }
}

function tab(id: string, groupId: string) {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const createEmptySplitGroup = vi.fn(() => MINTED_GROUP_ID)

/** One occupied pane in a leaf layout — what the rule reads before it mints the right group. */
function seedOnePaneRuntimeWorktree(): void {
  mocks.getState.mockReturnValue({
    ...mocks.getState(),
    layoutByWorktree: { [WORKTREE_ID]: { type: 'leaf', groupId: 'group-left' } },
    groupsByWorktree: { [WORKTREE_ID]: [group('group-left')] },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [tab('t1', 'group-left')] },
    activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-left' },
    createEmptySplitGroup
  })
}

function seedTwoPaneRuntimeWorktree(): void {
  mocks.getState.mockReturnValue({
    ...mocks.getState(),
    layoutByWorktree: {
      [WORKTREE_ID]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'group-left' },
        second: { type: 'leaf', groupId: 'group-right' }
      }
    },
    groupsByWorktree: { [WORKTREE_ID]: [group('group-left'), group('group-right')] },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [tab('t1', 'group-left'), tab('t2', 'group-right')]
    },
    activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-left' },
    createEmptySplitGroup
  })
}

function stubRuntimeCall(): ReturnType<typeof vi.fn> {
  const runtimeCall = vi
    .fn()
    .mockResolvedValueOnce({
      id: 'create',
      ok: true,
      result: { tab: { id: 'host-tab-2' }, publicationEpoch: 'epoch-1', snapshotVersion: 2 }
    })
    .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
  return runtimeCall
}

function requestedTargetGroupId(runtimeCall: ReturnType<typeof vi.fn>): unknown {
  return runtimeCall.mock.calls[0]?.[0]?.params?.targetGroupId
}

afterEach(() => resetWebSessionCloseIntentForTests())

describe('remote terminal placement beside a lone pane', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
    createEmptySplitGroup.mockClear()
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it('places the second remote terminal in a new right-hand group', async () => {
    seedOnePaneRuntimeWorktree()
    const runtimeCall = stubRuntimeCall()

    await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(createEmptySplitGroup).toHaveBeenCalledWith(WORKTREE_ID, 'group-left', 'right', {
      activate: false,
      recordInteraction: false
    })
    expect(requestedTargetGroupId(runtimeCall)).toBe(MINTED_GROUP_ID)
  })

  // Why group-right: both panes show terminals, so it opens opposite the focused left pane.
  it('never makes a third pane; opens opposite the focused pane', async () => {
    seedTwoPaneRuntimeWorktree()
    const runtimeCall = stubRuntimeCall()

    await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(createEmptySplitGroup).not.toHaveBeenCalled()
    expect(requestedTargetGroupId(runtimeCall)).toBe('group-right')
  })

  it('redirects a caller that named the lone group, and leaves any other group alone', async () => {
    // Why: terminal-active-workspace-creation passes the focused group — which IS the lone one.
    seedOnePaneRuntimeWorktree()
    const runtimeCall = stubRuntimeCall()

    await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      targetGroupId: 'group-left',
      activate: true
    })

    expect(requestedTargetGroupId(runtimeCall)).toBe(MINTED_GROUP_ID)
  })

  it('closes the pane it minted when the create fails', async () => {
    seedOnePaneRuntimeWorktree()
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: vi.fn().mockRejectedValue(new Error('host gone')) } }
    })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith(WORKTREE_ID, MINTED_GROUP_ID)
  })

  it('leaves a reused right-hand group alone when the create fails', async () => {
    seedTwoPaneRuntimeWorktree()
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: vi.fn().mockRejectedValue(new Error('host gone')) } }
    })

    await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      targetGroupId: 'group-right',
      activate: true
    })

    expect(mocks.closeEmptyGroup).not.toHaveBeenCalled()
  })

  it('honours placementFixed so a replay keeps its recorded group', async () => {
    seedOnePaneRuntimeWorktree()
    const runtimeCall = stubRuntimeCall()

    await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      targetGroupId: 'group-left',
      placementFixed: true,
      activate: true
    })

    expect(createEmptySplitGroup).not.toHaveBeenCalled()
    expect(requestedTargetGroupId(runtimeCall)).toBe('group-left')
  })
})
