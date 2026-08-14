import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-session'

const ENVIRONMENT_ID = 'runtime-1'
const WORKTREE_ID = 'repo::/worktree'

const mocks = vi.hoisted(() => ({
  closeEmptyGroup: vi.fn(),
  getState: vi.fn(),
  runtimeCall: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  applyFreshWebSessionTabsSnapshot: vi.fn(),
  applyWebSessionTabsStorePatch: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn()
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: vi.fn()
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: vi.fn()
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn()
}))

describe('paired browser capability cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: mocks.runtimeCall } }
    })
  })

  it.each([
    ['absent status', new Map()],
    [
      'unknown capabilities',
      new Map([[ENVIRONMENT_ID, { status: { capabilities: undefined }, checkedAt: 1 }]])
    ],
    [
      'mixed-version host',
      new Map([[ENVIRONMENT_ID, { status: { capabilities: [] }, checkedAt: 1 }]])
    ]
  ])('rejects %s and removes the caller-created split', async (_label, runtimeStatuses) => {
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
      runtimeStatusByEnvironmentId: runtimeStatuses,
      closeEmptyGroup: mocks.closeEmptyGroup
    })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        clientTargetGroupId: 'preview-group',
        clientTargetGroupCreated: true
      })
    ).rejects.toThrow('does not support browser streaming')

    expect(mocks.closeEmptyGroup).toHaveBeenCalledOnce()
    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith(WORKTREE_ID, 'preview-group')
    expect(mocks.runtimeCall).not.toHaveBeenCalled()
  })
})
