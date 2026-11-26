import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../../../../store/testing/app-store-test-fixture'
import { placeAgentLaunchSplit } from './agent-launch-split-placement'

const WT = 'repo1::/repo'
type Store = ReturnType<typeof createTestStore>

function chat(store: Store, id: string, sessionId: string, targetGroupId?: string): string {
  return store.getState().createUnifiedTab(WT, 'agent-session', {
    id,
    entityId: sessionId,
    activate: false,
    ...(targetGroupId ? { targetGroupId } : {})
  }).groupId
}

const NOW = 1_800_000_000_000
const request = (direction: 'right' | 'down', expiresAt = NOW + 10_000) => ({
  requestId: 'r1',
  worktreeId: WT,
  sessionId: 'worker-session',
  split: { direction, fromSessionId: 'caller-session' },
  activate: false,
  expiresAt
})

const groupOf = (store: Store, tabId: string) =>
  store.getState().unifiedTabsByWorktree[WT]?.find((tab) => tab.id === tabId)?.groupId

describe('placeAgentLaunchSplit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('splits a worker listed in the focused pane beside a caller alone in another, once', async () => {
    const store = createTestStore()
    const callerGroup = chat(store, 'chat-caller', 'caller-session')
    const editorGroup = store
      .getState()
      .createUnifiedTabInSplit(
        WT,
        'editor',
        { sourceGroupId: callerGroup, splitDirection: 'right' },
        { id: 'editor-1', entityId: '/repo/a.ts', activate: true }
      )?.groupId
    const pending = placeAgentLaunchSplit(store, request('down'))
    expect(chat(store, 'chat-worker', 'worker-session', editorGroup)).toBe(editorGroup)

    const placement = await pending

    const workerGroup = groupOf(store, 'chat-worker')
    expect(placement).toEqual({ groupId: workerGroup })
    expect(store.getState().layoutByWorktree[WT]).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', groupId: callerGroup },
        second: { type: 'leaf', groupId: workerGroup }
      },
      second: { type: 'leaf', groupId: editorGroup }
    })
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(editorGroup)

    const layout = store.getState().layoutByWorktree[WT]
    expect(await placeAgentLaunchSplit(store, request('down'))).toEqual(placement)
    expect(store.getState().layoutByWorktree[WT]).toEqual(layout)
  })

  it('moves a worker already alone on the wrong side of the caller', async () => {
    const store = createTestStore()
    const callerGroup = chat(store, 'chat-caller', 'caller-session')
    store
      .getState()
      .createUnifiedTabInSplit(
        WT,
        'agent-session',
        { sourceGroupId: callerGroup, splitDirection: 'right' },
        { id: 'chat-worker', entityId: 'worker-session', activate: false }
      )

    const placement = await placeAgentLaunchSplit(store, request('down'))

    expect(store.getState().layoutByWorktree[WT]).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: callerGroup },
      second: { type: 'leaf', groupId: placement.groupId }
    })
  })

  it('moves nothing once the request has expired', async () => {
    const store = createTestStore()
    const group = chat(store, 'chat-caller', 'caller-session')
    chat(store, 'chat-worker', 'worker-session')

    const placement = await placeAgentLaunchSplit(store, request('right', NOW - 1))

    expect(placement).toEqual({ groupId: group, fallback: 'not-split' })
    expect(store.getState().groupsByWorktree[WT]).toHaveLength(1)
  })
})
