import { describe, expect, it } from 'vitest'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import type { ActivityInboxEntry } from './activity-inbox-entries'
import { withOpenedEntry } from './activity-inbox-opened'

function thread(overrides: Partial<AgentPaneThread>): AgentPaneThread {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper reads paneKey, latestTimestamp and the status fields only.
  return { paneKey: 'a', unread: false, latestTimestamp: 1, ...overrides } as AgentPaneThread
}

function agent(source: AgentPaneThread): ActivityInboxEntry {
  return {
    kind: 'agent',
    key: `agent:${source.paneKey}`,
    at: 1,
    thread: source,
    ask: true,
    bot: null
  }
}

describe('withOpenedEntry', () => {
  it('leaves the list alone when nothing is opened or the opened row is still listed', () => {
    const listed = [agent(thread({}))]
    expect(withOpenedEntry(listed, null, [])).toBe(listed)
    expect(withOpenedEntry(listed, listed[0], [])).toBe(listed)
  })

  it('keeps an opened agent row after it leaves the inbox, with its pane as it is now', () => {
    const opened = agent(thread({ currentAgentState: 'waiting' }))
    const working = thread({ currentAgentState: 'working', latestTimestamp: 5 })
    const [kept] = withOpenedEntry([], opened, [working])
    expect(kept).toMatchObject({ key: 'agent:a', at: 5, ask: false })
    expect(kept.kind === 'agent' && kept.thread).toBe(working)
  })

  it('keeps an opened row as it was when its pane or item is gone', () => {
    const opened = agent(thread({}))
    expect(withOpenedEntry([], opened, [])).toEqual([opened])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only key and kind are read.
    const item = { kind: 'item', key: 'item:x', at: 2 } as ActivityInboxEntry
    expect(withOpenedEntry([], item, [])).toEqual([item])
  })
})
