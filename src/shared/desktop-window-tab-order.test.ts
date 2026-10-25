import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import { preserveConcurrentTabGroupOrder } from './desktop-window-tab-order'
import { patchStoredSession } from './workspace-layout/workspace-layout-record-patch'

function session(order: string[]) {
  return {
    ...getDefaultWorkspaceSession(),
    tabGroups: {
      workspace: [{ id: 'group', worktreeId: 'workspace', activeTabId: null, tabOrder: order }]
    }
  }
}

describe('concurrent native tab order', () => {
  it.each([
    {
      name: 'no local order change',
      before: ['a', 'b'],
      peer: ['b', 'a'],
      local: ['a', 'b'],
      expected: ['b', 'a']
    },
    {
      name: 'only a local addition',
      before: ['a', 'b'],
      peer: ['b', 'a'],
      local: ['a', 'b', 'c'],
      expected: ['b', 'c', 'a']
    },
    {
      name: 'only a local removal',
      before: ['a', 'b', 'c'],
      peer: ['c', 'b', 'a'],
      local: ['a', 'c'],
      expected: ['c', 'a']
    },
    {
      name: 'a local reorder with a peer addition',
      before: ['a', 'b'],
      peer: ['a', 'x', 'b'],
      local: ['b', 'a'],
      expected: ['b', 'x', 'a']
    }
  ])(
    'merges $name without restoring an unchanged old order',
    ({ before, peer, local, expected }) => {
      const baseline = session(before)
      const stored = session(peer)
      const incoming = session(local)
      const result = preserveConcurrentTabGroupOrder(
        stored,
        baseline,
        incoming,
        patchStoredSession(stored, baseline, incoming)
      )
      expect(result.tabGroups?.workspace?.[0]?.tabOrder).toEqual(expected)
    }
  )
})
