// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { withHeldTabsAsDrawn } from '@/store/workspace-layout/frames/workspace-layout-frame-held-tabs'
import {
  isDrawnTabHeld,
  isDrawnGroupLayoutHeld
} from '@/runtime/workspace-layout/intents/layout-owner-drawn-tab-holds'
import type { NativeChatForkRequest, NativeChatForkOutcome } from './native-chat-fork-launch'
import { removeStructuredLaunchSlot } from '@/lib/agent-session/launch/structured-agent-session-launch-slot'
import { newGroupSplitOf } from '@/runtime/workspace-layout/commands/layout-owner-new-group-split'
import { reserveStructuredLaunchSlot } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'

const mocks = vi.hoisted(() => {
  const store: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return {
    store,
    launch: vi.fn<(request: NativeChatForkRequest) => Promise<NativeChatForkOutcome>>()
  }
})
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => mocks.store.current!.getState(),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      mocks.store.current!.subscribe(...args)
  }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('./native-chat-fork-launch', () => ({ launchNativeChatFork: mocks.launch }))
vi.mock(
  '@/runtime/native-chat/session-ownership/structured-agent-session-owner',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    structuredAgentSessionOwnerForTab: () => 'runtime:melon',
    structuredAgentSessionTargetForHost: () => ({ kind: 'environment', environmentId: 'melon' })
  })
)
vi.mock(
  '@/runtime/native-chat/status/structured-agent-session-status-feed',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getStructuredAgentSessionStatusFeed: () => ({ getNamingSnapshot: () => new Map() })
  })
)
vi.mock('../../../tab-group/drag/tab-group-panel-split-target', () => ({
  getTabGroupPanelRect: () => ({ width: 1200, height: 800 })
}))

const { openCurrentSideChat } = await import('./current-side-chat-launch')
const WORKSPACE = 'repo1::/tmp/side-chat'

beforeEach(() => {
  mocks.store.current = createTestStore()
  mocks.launch.mockReset()
})

it('keeps the requested side pane through a host frame while the fork is pending', async () => {
  const store = mocks.store.current!
  const parent = store.getState().createUnifiedTab(WORKSPACE, 'agent-session', {
    id: 'agent-session:parent',
    entityId: 'parent',
    agentSessionAgent: 'codex',
    executionHostId: 'runtime:melon'
  })
  store.setState({ settings: { ...store.getState().settings!, nativeChatSideChatPane: true } })
  const hostFrame = store.getState()
  const fork = Promise.withResolvers<{}>()
  mocks.launch.mockImplementation((request: NativeChatForkRequest) => {
    const launch = {
      sessionId: 'child',
      executionHostId: 'runtime:melon' as const,
      agent: 'codex' as const,
      surfaceAddress: request.surfaceAddress,
      params: { forkFrom: request.forkFrom }
    }
    reserveStructuredLaunchSlot(launch)
    return fork.promise
  })
  const opening = openCurrentSideChat(WORKSPACE, parent.id)
  const request = mocks.launch.mock.calls[0]![0]
  const destination = request.surfaceAddress.targetGroupId
  try {
    expect(destination).not.toBe(parent.groupId)
    const patch = withHeldTabsAsDrawn(store.getState(), hostFrame, [WORKSPACE], {
      isTabHeld: isDrawnTabHeld,
      isGroupLayoutHeld: isDrawnGroupLayoutHeld
    })
    store.setState(patch)
    expect(store.getState().groupsByWorktree[WORKSPACE]?.some((g) => g.id === destination)).toBe(
      true
    )
    expect(
      newGroupSplitOf(store.getState(), WORKSPACE, destination!, 'structured-agent-session-child')
    ).toEqual({
      split: { besideGroupId: parent.groupId, direction: 'right' }
    })
  } finally {
    removeStructuredLaunchSlot(store.getState(), WORKSPACE, 'child')
    fork.resolve({})
    await opening
  }
})
