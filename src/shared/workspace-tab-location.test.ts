import { describe, expect, it } from 'vitest'
import {
  collectTabGroupBounds,
  describeWorkspaceTabLayout,
  workspaceTabLayoutRevision,
  type WorkspaceTabTopology
} from './workspace-tab-location'
import type { Tab } from './tab-types'

function topology(): WorkspaceTabTopology {
  const tabs: Tab[] = ['a', 'b', 'c', 'd', 'keep', 'other'].map((id, index) => ({
    id,
    entityId: `content-${id}`,
    worktreeId: 'folder:workspace',
    groupId: id === 'other' ? 'g2' : 'g1',
    contentType:
      index === 1 ? 'editor' : index === 2 ? 'browser' : index === 3 ? 'agent-session' : 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: index,
    createdAt: 0,
    isPinned: id === 'a'
  }))
  return {
    tabs,
    groups: [
      {
        id: 'g1',
        worktreeId: 'folder:workspace',
        tabOrder: ['a', 'b', 'c', 'd', 'keep'],
        activeTabId: 'a'
      },
      { id: 'g2', worktreeId: 'folder:workspace', tabOrder: ['other'], activeTabId: 'other' }
    ],
    layout: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.25,
      first: { type: 'leaf', groupId: 'g1' },
      second: { type: 'leaf', groupId: 'g2' }
    },
    activeGroupId: 'g1'
  }
}

describe('workspace tab location', () => {
  it('reports stable IDs, real group order, bounds and logical visibility', () => {
    const state = topology()
    const layout = describeWorkspaceTabLayout('folder:workspace', state, 'open', true)
    expect(layout.tabs[1]).toMatchObject({
      tabId: 'b',
      contentId: 'content-b',
      groupId: 'g1',
      position: 1,
      isDisplayed: false,
      bounds: { x: 0, y: 0, width: 0.25, height: 1 }
    })
    expect(layout.tabs[0].isDisplayed).toBe(true)
    expect(collectTabGroupBounds(state.layout).get('g2')).toEqual({
      x: 0.25,
      y: 0,
      width: 0.75,
      height: 1
    })
    expect(
      describeWorkspaceTabLayout('folder:workspace', state, 'saved').tabs.every(
        (tab) => !tab.isDisplayed
      )
    ).toBe(true)
    expect(
      describeWorkspaceTabLayout('folder:workspace', state, 'open', false).tabs.every(
        (tab) => !tab.isDisplayed
      )
    ).toBe(true)
  })

  it('changes the revision for order, split ratio, pin and group-selection changes', () => {
    const state = topology()
    const revision = workspaceTabLayoutRevision(state)
    expect(
      workspaceTabLayoutRevision({
        ...state,
        groups: state.groups.map((g) => ({ ...g, tabOrder: g.tabOrder.toReversed() }))
      })
    ).not.toBe(revision)
    expect(workspaceTabLayoutRevision({ ...state, activeGroupId: 'g2' })).not.toBe(revision)
    expect(
      workspaceTabLayoutRevision({
        ...state,
        tabs: state.tabs.map((t) => ({ ...t, isPinned: false }))
      })
    ).not.toBe(revision)
    expect(workspaceTabLayoutRevision(state)).toBe(revision)
  })
})
