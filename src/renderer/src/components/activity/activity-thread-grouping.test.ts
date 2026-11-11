import { describe, expect, it } from 'vitest'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'
import { buildActivityThreadGroups } from './activity-thread-grouping'
import type { AgentPaneThread } from './activity-thread-types'

function thread(
  paneKey: string,
  currentAgentState: AgentPaneThread['currentAgentState'],
  unread: boolean
): AgentPaneThread {
  return {
    paneKey,
    paneTitle: paneKey,
    worktree: makeWorktree(),
    repo: null,
    tab: makeTab(),
    agentType: 'codex',
    currentAgentState,
    currentAgentEntry: null,
    responsePreview: '',
    latestTimestamp: 1000,
    latestEvent: null,
    events: [],
    unread
  }
}

describe('Activity completion groups', () => {
  it('separates unread completions ahead of read completions while keeping live status priority', () => {
    const groups = buildActivityThreadGroups(
      [
        thread('read', null, false),
        thread('unread-first', null, true),
        thread('working', 'working', false),
        thread('waiting', 'waiting', true),
        thread('unread-second', null, true)
      ],
      'status'
    )

    expect(groups.map((group) => group.threads.map((entry) => entry.paneKey))).toEqual([
      ['waiting'],
      ['working'],
      ['unread-first', 'unread-second'],
      ['read']
    ])
  })

  it('moves completions between the two groups when their read state changes', () => {
    const read = thread('read', null, false)
    const unread = thread('unread', null, true)
    const groups = (entries: AgentPaneThread[]) =>
      buildActivityThreadGroups(entries, 'status').map((group) =>
        group.threads.map((entry) => entry.paneKey)
      )

    expect(groups([read, unread])).toEqual([['unread'], ['read']])
    expect(groups([read, { ...unread, unread: false }])).toEqual([['read', 'unread']])
    expect(groups([{ ...read, unread: true }, unread])).toEqual([['read', 'unread']])
  })
})
