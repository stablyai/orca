import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../../shared/tab-types'
import { replaceTabBuckets } from '@/store/keyed-record-transitions'
import { getStructuredAgentSessionTabs } from './structured-agent-session-tabs'

function tab(id: string, worktreeId: string, contentType: Tab['contentType']): Tab {
  return {
    id,
    worktreeId,
    groupId: 'group',
    contentType,
    entityId: contentType === 'agent-session' ? 'session-shared' : id,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPinned: false,
    ...(contentType === 'agent-session' ? { agentSessionAgent: 'codex' as const } : {})
  }
}

const ids = (map: Record<string, Tab[]>) => getStructuredAgentSessionTabs(map).map((t) => t.id)

describe('getStructuredAgentSessionTabs order', () => {
  it('keeps source workspace order through addressed close and reopen', () => {
    const start = {
      early: [tab('t1', 'early', 'terminal'), tab('c1', 'early', 'agent-session')],
      later: [tab('c2', 'later', 'agent-session')]
    }
    expect(ids(start)).toEqual(['c1', 'c2'])
    const closed = replaceTabBuckets(start, [['early', [start.early[0]]]])
    expect(ids(closed)).toEqual(['c2'])
    const reopened = replaceTabBuckets(closed, [
      ['early', [start.early[0], tab('c1b', 'early', 'agent-session')]]
    ])
    expect(ids(reopened)).toEqual(['c1b', 'c2'])
    expect(ids({ ...reopened })).toEqual(['c1b', 'c2'])
  })

  it('follows source order when a workspace is deleted and added back', () => {
    const start = {
      early: [tab('c1', 'early', 'agent-session')],
      later: [tab('c2', 'later', 'agent-session')]
    }
    expect(ids(start)).toEqual(['c1', 'c2'])
    const removed = replaceTabBuckets(start, [['early', null]])
    const restored = replaceTabBuckets(removed, [['early', start.early]])
    expect(ids(restored)).toEqual(['c2', 'c1'])
    expect(ids({ ...restored })).toEqual(['c2', 'c1'])
  })
})
