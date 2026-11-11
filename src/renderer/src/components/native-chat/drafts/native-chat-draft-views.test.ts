import { afterEach, describe, expect, it } from 'vitest'
import {
  appendNativeChatDraftCacheManual,
  readNativeChatDraftCache,
  readNativeChatDraftDocument,
  writeNativeChatDraftDocument
} from './native-chat-draft-views'
import { clearNativeChatComposerDraftsForTests } from './native-chat-draft-reset'

afterEach(() => {
  clearNativeChatComposerDraftsForTests()
})

describe('native-chat draft views', () => {
  it('keeps a structured draft when a block is appended by hand, so a picked skill survives', () => {
    writeNativeChatDraftDocument('pty-1', 'summarize this', {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'summarize this' }] }]
    })

    appendNativeChatDraftCacheManual('pty-1', '```js\ncode()\n```')

    expect(readNativeChatDraftCache('pty-1')).toBe('summarize this\n\n```js\ncode()\n```')
    expect(readNativeChatDraftDocument('pty-1', readNativeChatDraftCache('pty-1'))).toBeDefined()
  })
})
