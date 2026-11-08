import { expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { buildMobileSessionTabSnapshots } from './mobile-session-snapshots'
import { makeState } from './testing/sync-runtime-graph-test-harness'

function makeTab(overrides: Pick<Tab, 'id' | 'entityId' | 'contentType'>): Tab {
  return {
    groupId: 'group-1',
    worktreeId: 'wt-1',
    label: overrides.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

it('invalidates the production snapshot cache when the selected host chat lifetime changes', async () => {
  const { setHostSessionTabIdMapping, clearHostSessionTabIdMappings } =
    await import('../web-session-tabs-sync/tracking-mappings')
  const chat = makeTab({ id: 'window-chat', entityId: 'chat-0001', contentType: 'agent-session' })
  const state = makeState({
    unifiedTabsByWorktree: { 'wt-1': [chat] },
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          worktreeId: 'wt-1',
          activeTabId: chat.id,
          tabOrder: [chat.id],
          recentTabIds: [chat.id]
        }
      ]
    }
  })
  try {
    const legacy = buildMobileSessionTabSnapshots(state)[0]
    setHostSessionTabIdMapping(
      { environmentId: 'local', worktreeId: 'wt-1', tabId: chat.id },
      'agent-chat-tab-v1-a'
    )
    const issued = buildMobileSessionTabSnapshots(state)[0]
    expect(issued).not.toBe(legacy)
    expect(issued?.tabGroups?.[0]).toMatchObject({
      tabOrder: ['agent-chat-tab-v1-a'],
      activeTabId: 'agent-chat-tab-v1-a',
      recentTabIds: ['agent-chat-tab-v1-a']
    })
    expect(buildMobileSessionTabSnapshots(state)[0]).toBe(issued)
    setHostSessionTabIdMapping(
      { environmentId: 'local', worktreeId: 'wt-1', tabId: chat.id },
      'agent-chat-tab-v1-b'
    )
    expect(buildMobileSessionTabSnapshots(state)[0]?.tabGroups?.[0]?.tabOrder).toEqual([
      'agent-chat-tab-v1-b'
    ])
  } finally {
    clearHostSessionTabIdMappings('local', 'wt-1')
  }
})
