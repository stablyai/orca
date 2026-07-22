import { describe, expect, it } from 'vitest'
import {
  preferredTabIdsFromGroups,
  resolveSessionAgentTerminalTabId
} from './resolve-session-agent-tab'

describe('resolveSessionAgentTerminalTabId', () => {
  const tabs = [
    { id: 'collab-1', contentType: 'collab-canvas' },
    { id: 'term-a', contentType: 'terminal' },
    { id: 'term-b', contentType: 'terminal' },
    { id: 'ed-1', contentType: 'editor' }
  ]

  it('returns first terminal when no preference', () => {
    expect(resolveSessionAgentTerminalTabId({ tabs })).toBe('term-a')
  })

  it('honors preferred order', () => {
    expect(
      resolveSessionAgentTerminalTabId({
        tabs,
        preferredTabIds: ['ed-1', 'term-b', 'term-a']
      })
    ).toBe('term-b')
  })

  it('returns null when no terminal', () => {
    expect(
      resolveSessionAgentTerminalTabId({
        tabs: [{ id: 'c', contentType: 'collab-canvas' }]
      })
    ).toBeNull()
  })
})

describe('preferredTabIdsFromGroups', () => {
  it('most-recent first across groups', () => {
    expect(
      preferredTabIdsFromGroups([
        { recentTabIds: ['t1', 't2'] },
        { recentTabIds: ['t3'] }
      ])
    ).toEqual(['t2', 't1', 't3'])
  })
})
