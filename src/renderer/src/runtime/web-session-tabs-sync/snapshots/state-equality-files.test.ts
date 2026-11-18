import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { toVisibleTabType } from './state-equality-files'

function tab(contentType: Tab['contentType']): Tab {
  return {
    id: 't1',
    entityId: 'e1',
    groupId: 'g1',
    worktreeId: 'w1',
    contentType,
    label: 'x',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('toVisibleTabType', () => {
  it('shows a room where an agent chat is, so a host sync keeps it a chat', () => {
    expect(toVisibleTabType(tab('room'))).toBe('agent-session')
    expect(toVisibleTabType(tab('terminal'))).toBe('terminal')
  })
})
