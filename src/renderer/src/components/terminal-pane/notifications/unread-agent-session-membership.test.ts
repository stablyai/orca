import { describe, expect, it } from 'vitest'
import { replaceTabBuckets } from '@/store/keyed-record-transitions'
import { hasUnreadAgentSessionTab } from './unread-agent-session-membership'

describe('unread agent-session membership', () => {
  it('keeps eligible duplicates until their last workspace membership leaves', () => {
    const initial: Record<string, { id: string; contentType?: string }[]> = {
      first: [
        { id: 'same-bucket' },
        { id: 'same-bucket', contentType: 'agent-session' },
        { id: 'cross-bucket', contentType: 'terminal' }
      ],
      second: [
        { id: 'cross-bucket', contentType: 'agent-session' },
        { id: 'same-bucket', contentType: 'agent-session' }
      ]
    }
    expect(hasUnreadAgentSessionTab(initial, 'same-bucket')).toBe(true)
    expect(hasUnreadAgentSessionTab(initial, 'cross-bucket')).toBe(true)

    const moved = replaceTabBuckets(initial, [['first', null]])
    expect(hasUnreadAgentSessionTab(moved, 'same-bucket')).toBe(true)

    const replaced = replaceTabBuckets<{ id: string; contentType?: string }>(moved, [
      ['second', [{ id: 'same-bucket', contentType: 'terminal' }]]
    ])
    expect(hasUnreadAgentSessionTab(replaced, 'same-bucket')).toBe(false)
    expect(hasUnreadAgentSessionTab(replaced, 'cross-bucket')).toBe(false)
  })

  it('reconciles unannotated replacements, removed buckets and older snapshots', () => {
    const initial = { first: [{ id: 'chat', contentType: 'agent-session' }] }
    expect(hasUnreadAgentSessionTab(initial, 'chat')).toBe(true)

    const next = { second: [{ id: 'next-chat', contentType: 'agent-session' }] }
    expect(hasUnreadAgentSessionTab(next, 'chat')).toBe(false)
    expect(hasUnreadAgentSessionTab(next, 'next-chat')).toBe(true)
    expect(hasUnreadAgentSessionTab(initial, 'chat')).toBe(true)
    expect(hasUnreadAgentSessionTab(initial, 'next-chat')).toBe(false)
    expect(hasUnreadAgentSessionTab(undefined, 'chat')).toBe(false)
  })
})
