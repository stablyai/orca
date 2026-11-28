import { describe, expect, it } from 'vitest'
import { findNativeChatPinnedPrompt } from './native-chat-pinned-prompt'
import type { NativeChatRailItem } from './native-chat-message-rail-items'

const prompt = (id: string, slotIndex: number | null, text = id): NativeChatRailItem => ({
  id,
  slotIndex,
  text,
  hasImages: false,
  timestamp: null
})

describe('findNativeChatPinnedPrompt', () => {
  const items = [prompt('a', 0), prompt('b', 4), prompt('c', 8)]

  it('pins the prompt the rail names for the top edge', () => {
    expect(findNativeChatPinnedPrompt({ activeId: 'b', items, readerAtEnd: false })).toBe(items[1])
  })

  it('pins nothing at the end of the transcript, where the composer shows the prompt', () => {
    expect(findNativeChatPinnedPrompt({ activeId: 'c', items, readerAtEnd: true })).toBeNull()
  })

  it('pins nothing for an outline prompt whose row has not been loaded', () => {
    expect(
      findNativeChatPinnedPrompt({
        activeId: 'old',
        items: [...items, prompt('old', null)],
        readerAtEnd: false
      })
    ).toBeNull()
  })

  it('pins nothing before the rail has settled on a prompt', () => {
    expect(findNativeChatPinnedPrompt({ activeId: null, items, readerAtEnd: false })).toBeNull()
  })

  it('pins nothing when the rail names a prompt it no longer carries', () => {
    expect(findNativeChatPinnedPrompt({ activeId: 'gone', items, readerAtEnd: false })).toBeNull()
  })
})
