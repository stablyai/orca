import { describe, expect, it } from 'vitest'
import { nativeChatNoticeBlock, nativeChatNoticeLook } from './native-chat-notice'
import type { NativeChatTextBlock } from './native-chat-types'

const block = (fields: Partial<NativeChatTextBlock>): NativeChatTextBlock => ({
  type: 'text',
  text: 'words',
  ...fields
})

describe('nativeChatNoticeLook', () => {
  it.each([
    [{ presentation: 'compaction' }, { kind: 'divider', label: 'compaction' }],
    [{ presentation: 'context-cleared' }, { kind: 'divider', label: 'contextCleared' }],
    [{ presentation: 'command-output' }, { kind: 'command-output' }],
    [
      { presentation: 'history-repaired' },
      { kind: 'host-status', presentation: 'history-repaired' }
    ],
    [{ presentation: 'plan-document' }, { kind: 'plan' }],
    [{ presentation: 'stopped-before-start' }, { kind: 'aside' }],
    // Stored red for clients that predate the orca-stop row; Orca stopped it, nothing failed.
    [
      { presentation: 'orca-stop', tone: 'error' },
      { kind: 'line', tone: 'notice' }
    ],
    [
      { presentation: 'compaction-skipped', tone: 'warning' },
      { kind: 'line', tone: 'warning' }
    ],
    [{ tone: 'error' }, { kind: 'line', tone: 'error' }],
    [{ tone: 'loud' }, { kind: 'line', tone: null }]
  ] as const)('reads %j as %j', (fields, look) => {
    expect(nativeChatNoticeLook(block(fields))).toEqual(look)
  })
})

describe('nativeChatNoticeBlock', () => {
  it('finds the block with a presentation or tone, and none in plain words', () => {
    const notice = block({ tone: 'warning' })
    expect(nativeChatNoticeBlock([block({}), notice])).toBe(notice)
    expect(nativeChatNoticeBlock([block({})])).toBeUndefined()
  })
})
