import { afterEach, describe, expect, it } from 'vitest'
import {
  clearNativeChatSideQuestContext,
  clearNativeChatSideQuestContextCacheForTests,
  readNativeChatSideQuestContext,
  seedNativeChatSideQuestContext
} from './native-chat-side-quest-context-cache'

describe('native-chat-side-quest-context-cache', () => {
  afterEach(() => {
    clearNativeChatSideQuestContextCacheForTests()
  })

  it('seeds, reads, and clears quoted context by terminal tab id', () => {
    seedNativeChatSideQuestContext('tab-1', { sourceLabel: 'Terminal', text: 'output' })

    expect(readNativeChatSideQuestContext('tab-1')).toEqual({
      sourceLabel: 'Terminal',
      text: 'output'
    })
    clearNativeChatSideQuestContext('tab-1')
    expect(readNativeChatSideQuestContext('tab-1')).toBeNull()
  })
})
