import { describe, expect, it } from 'vitest'
import { nativeChatToolLineView } from './native-chat-tool-line-view'

describe('nativeChatToolLineView', () => {
  it('previews a lone result by its first non-blank line', () => {
    expect(
      nativeChatToolLineView({ type: 'tool-result', output: '\n\n  done: 3 files\nmore' })
        .resultPreview
    ).toBe('done: 3 files')
  })
})
