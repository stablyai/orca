import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'

const WT = 'repo1::/path/wt1'

const entry: Tab = {
  id: 'tab-a',
  entityId: 'tab-a',
  groupId: 'kept',
  worktreeId: WT,
  contentType: 'terminal',
  label: 'Terminal 1',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

// Main closes a group with its last tab; the window may keep it shown empty. Its save must not
// bring that group back.
describe('buildPersistedUnifiedTabSessionData', () => {
  it('saves no group the window holds empty, nor its place in the group tree', () => {
    const saved = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WT]: [entry] },
      groupsByWorktree: {
        [WT]: [
          { id: 'emptied', worktreeId: WT, activeTabId: null, tabOrder: [] },
          { id: 'kept', worktreeId: WT, activeTabId: 'tab-a', tabOrder: ['tab-a'] }
        ]
      },
      layoutByWorktree: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: 'emptied' },
          second: { type: 'leaf', groupId: 'kept' }
        }
      },
      activeGroupIdByWorktree: { [WT]: 'emptied' }
    })

    expect(saved.tabGroups?.[WT]?.map((group) => group.id)).toEqual(['kept'])
    expect(saved.tabGroupLayouts?.[WT]).toEqual({ type: 'leaf', groupId: 'kept' })
    expect(saved.activeGroupIdByWorktree?.[WT]).toBe('kept')
  })

  it('saves nothing for a workspace whose only group the window holds empty', () => {
    const saved = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WT]: [] },
      groupsByWorktree: { [WT]: [{ id: 'root', worktreeId: WT, activeTabId: null, tabOrder: [] }] },
      layoutByWorktree: { [WT]: { type: 'leaf', groupId: 'root' } },
      activeGroupIdByWorktree: { [WT]: 'root' }
    })

    expect(saved.tabGroups).toEqual({})
    expect(saved.tabGroupLayouts).toEqual({})
  })
})
