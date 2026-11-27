import { describe, expect, it } from 'vitest'
import { chatViewRetention } from './native-chat-view-retention'

const retained = (ids: readonly string[]): string[] =>
  chatViewRetention.retainedAmong(new Set(ids)).split('\n').filter(Boolean)

describe('chatViewRetention', () => {
  it('keeps shown chats plus the 3 most recently shown hidden ones, however many were visited', () => {
    const ids = Array.from({ length: 50 }, (_, index) => `tab-${String(index).padStart(2, '0')}`)
    for (const id of ids) {
      chatViewRetention.show('layer-a', [id])
    }
    expect(retained(ids)).toEqual(['tab-46', 'tab-47', 'tab-48', 'tab-49'])

    chatViewRetention.show('layer-b', ['other'])
    chatViewRetention.show('layer-a', [])
    expect(retained([...ids, 'other'])).toEqual(['other', 'tab-47', 'tab-48', 'tab-49'])

    chatViewRetention.forget(new Set(['tab-49']))
    expect(retained(ids)).toEqual(['tab-47', 'tab-48'])

    const release = chatViewRetention.hold('tab-00')
    expect(retained(ids)).toContain('tab-00')
    release()
    expect(retained(ids)).not.toContain('tab-00')
    chatViewRetention.show('layer-b', [])
  })
})
