import { describe, expect, it } from 'vitest'
import { splitSentImagePromptMarkers } from './native-chat-sent-image-prompt-markers'

describe('splitSentImagePromptMarkers', () => {
  it('cuts text at each marker, whether it sits before, between or after words', () => {
    expect(splitSentImagePromptMarkers('[Image #1] look at [Image #2] and\n[Image #3]', 3)).toEqual(
      [1, ' look at ', 2, ' and\n', 3]
    )
  })

  it('leaves markers in code, out-of-range numbers and unsent text literal', () => {
    expect(splitSentImagePromptMarkers('a `[Image #1]` b [Image #9]', 1)).toEqual([
      'a `[Image #1]` b [Image #9]'
    ])
    expect(splitSentImagePromptMarkers('```\n[Image #1]\n```\n[Image #1]', 1)).toEqual([
      '```\n[Image #1]\n```\n',
      1
    ])
    expect(splitSentImagePromptMarkers('[Image #1]', 0)).toEqual(['[Image #1]'])
  })
})
