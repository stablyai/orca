// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useMemo } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { Tab } from '../../../shared/tab-types'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { structuredAgentSessionTargetForHost } from './structured-agent-session-owner'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import {
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState,
  WT
} from './web-session-tabs-sync-test-harness'
import { useStructuredAgentSessionRead } from '../components/native-chat/use-structured-agent-session-read'
import { resetStructuredAgentSessionReadOwnersForTests } from '../components/native-chat/structured-agent-session-read-owner'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))

const SESSION = 'pi-session'
const snapshot = makeSnapshot(
  [
    {
      type: 'agent-session',
      id: 'host-chat',
      sessionId: SESSION,
      agent: 'pi',
      title: 'Running task',
      isActive: true
    }
  ],
  { activeTabId: 'host-chat', activeTabType: 'agent-session' }
)
const cursor = { epoch: 'epoch-a', sequence: 1 }
const history: AgentSessionHistoryPage = {
  sessionId: SESSION,
  epoch: cursor.epoch,
  direction: 'tail',
  items: [
    {
      itemId: 'reply',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Existing progress' }]
      }
    }
  ],
  removedItemIds: [],
  submissions: [],
  window: { oldest: cursor, newest: cursor, nextCursor: cursor },
  liveCursor: cursor,
  hasOlder: false,
  hasNewer: false
}

function ChatRead({ tab }: { tab: Tab }) {
  const target = useMemo(
    () => structuredAgentSessionTargetForHost(tab.executionHostId),
    [tab.executionHostId]
  )
  if (!target) {
    throw new Error('Missing chat owner')
  }
  const { state } = useStructuredAgentSessionRead({
    sessionId: tab.entityId,
    target,
    isViewed: false
  })
  return (
    <div data-testid="chat">
      {state.items.map((item) => (
        <div key={item.itemId}>
          {item.body.kind === 'message'
            ? item.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
            : ''}
        </div>
      ))}
    </div>
  )
}

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
  resetStructuredAgentSessionReadOwnersForTests()
  mocks.call.mockReset()
  mocks.subscribe.mockReset().mockResolvedValue({ unsubscribe: vi.fn() })
  mocks.call
    .mockResolvedValueOnce({ ok: true, page: history })
    .mockImplementation(() => new Promise(() => {}))
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionReadOwnersForTests()
})

it.each([
  ['paired routes', 'windows', 'windows-control', WT],
  ['local and remote', LOCAL_STRUCTURED_SESSION_OWNER, 'windows', WT],
  ['folder workspace', 'windows', 'windows-control', 'folder:shared-folder']
])('keeps displayed progress across %s updates', async (_label, owner, peer, worktree) => {
  const emits: ((event: AgentSessionSubscribeEvent) => void)[] = []
  mocks.subscribe.mockImplementation((_target, _params, onEvent) => {
    emits.push(onEvent)
    return Promise.resolve({ unsubscribe: vi.fn() })
  })
  const frame = { ...snapshot, worktree }
  let state = makeState({ activeWorktreeId: worktree })
  state = { ...state, ...applyWebSessionTabsSnapshot(state, frame, owner, 1) }
  const selected = state.unifiedTabsByWorktree[worktree]![0]!
  const view = render(<ChatRead tab={selected} />)
  const progress = await screen.findByText('Existing progress')

  for (const environment of [peer, owner, peer, owner]) {
    await act(async () => {
      frame.snapshotVersion += 1
      state = { ...state, ...applyWebSessionTabsSnapshot(state, frame, environment, 2) }
      const tab = state.unifiedTabsByWorktree[worktree]?.find((row) => row.id === selected.id)
      if (!tab) {
        throw new Error('The displayed chat was removed')
      }
      view.rerender(<ChatRead tab={tab} />)
    })
    expect(screen.queryByText('Existing progress')).toBe(progress)
    expect(progress).toBeInTheDocument()
  }
  expect(mocks.call).toHaveBeenCalledTimes(1)
  expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  act(() => {
    emits[0]!({
      type: 'batch',
      sessionId: SESSION,
      working: true,
      batch: {
        cursor: { ...cursor, sequence: 2 },
        items: [
          {
            itemId: 'next-reply',
            revision: 1,
            sequence: 2,
            observedAt: 2,
            body: {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'More progress' }]
            }
          }
        ],
        removedItemIds: [],
        submissions: []
      }
    })
  })
  expect(await screen.findByText('More progress')).toBeInTheDocument()
  expect(screen.getByText('Existing progress')).toBe(progress)
})

it('only retires the publishing route’s chats when its inventory becomes empty', () => {
  let state = makeState()
  for (const environment of ['windows', 'windows-control']) {
    state = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, environment, 1) }
  }
  const original = state.unifiedTabsByWorktree[WT]?.find(
    (tab) => tab.executionHostId === 'runtime:windows'
  )
  expect(original).toBeDefined()
  const empty = { ...snapshot, tabs: [], activeTabId: null, activeTabType: null }
  state = { ...state, ...applyWebSessionTabsSnapshot(state, empty, 'windows-control', 2) }
  expect(state.unifiedTabsByWorktree[WT]).toEqual([original])
  state = { ...state, ...applyWebSessionTabsSnapshot(state, empty, 'windows', 3) }
  expect(state.unifiedTabsByWorktree[WT] ?? []).toEqual([])
})

it('does not adopt another route’s tab when the host replaces a session', () => {
  let state = makeState()
  for (const environment of ['windows', 'windows-control']) {
    state = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, environment, 1) }
  }
  const original = state.unifiedTabsByWorktree[WT]?.find(
    (tab) => tab.executionHostId === 'runtime:windows'
  )
  const peer = state.unifiedTabsByWorktree[WT]?.find(
    (tab) => tab.executionHostId === 'runtime:windows-control'
  )
  expect(original?.id).not.toBe(peer?.id)
  const replacement = makeSnapshot([
    {
      type: 'agent-session',
      id: 'new-host-chat',
      sessionId: 'new-session',
      replacesSessionId: SESSION,
      agent: 'pi',
      title: 'Continued task',
      isActive: true
    }
  ])
  state = { ...state, ...applyWebSessionTabsSnapshot(state, replacement, 'windows-control', 2) }
  expect(state.unifiedTabsByWorktree[WT]?.find((tab) => tab.id === original?.id)).toEqual(original)
  expect(state.unifiedTabsByWorktree[WT]?.find((tab) => tab.id === peer?.id)).toMatchObject({
    entityId: 'new-session',
    executionHostId: 'runtime:windows-control'
  })
})
