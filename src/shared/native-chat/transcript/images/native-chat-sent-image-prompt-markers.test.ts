import { describe, expect, it } from 'vitest'
import { stripSentImagePromptMarkers } from './native-chat-sent-image-prompt-markers'

describe('native-chat-sent-image-prompt-markers backtick protection', () => {
  it('protects markers inside matched inline code spans and strips markers after unmatched openers or paragraph breaks', () => {
    expect(stripSentImagePromptMarkers('see `[Image #1]` and [Image #1]', 1)).toBe(
      'see `[Image #1]` and'
    )
    expect(stripSentImagePromptMarkers('unmatched ` opener\n\n` [Image #1]', 1)).toBe(
      'unmatched ` opener\n\n`'
    )
    expect(stripSentImagePromptMarkers('see ``foo ` [Image #1] bar`` [Image #1]', 1)).toBe(
      'see ``foo ` [Image #1] bar``'
    )
  })

  it('stays linear on many unmatched backtick runs of distinct lengths', () => {
    const runs = Array.from({ length: 1500 }, (_, i) => '`'.repeat((i % 20) + 1)).join(' x ')
    const input = `${runs} [Image #1]`
    expect(stripSentImagePromptMarkers(input, 1)).toBe(runs)
  })
})
