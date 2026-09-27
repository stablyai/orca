import { afterEach, describe, expect, it } from 'vitest'
import { hasAgentUnsentDraft, resetAgentUnsentDraftsForTests } from '@/lib/agent-unsent-draft'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from './native-chat-composer-scope-cache'
import {
  clearNativeChatDraftCacheForTests,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'

afterEach(() => {
  clearNativeChatDraftCacheForTests()
  resetAgentUnsentDraftsForTests()
})

describe('native chat draft as an unsent-draft source', () => {
  it('marks the pane while the composer holds text and clears it on send', () => {
    writeNativeChatDraftCache('tab-1:leaf-1', 'meia mensagem')
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(true)

    // Sending empties the composer through this same cache.
    writeNativeChatDraftCache('tab-1:leaf-1', '')
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(false)
  })

  it('treats whitespace as nothing waiting', () => {
    writeNativeChatDraftCache('tab-1:leaf-1', '   \n ')

    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(false)
  })

  it('retires the marker of a draft the cache evicted, so none is a phantom', () => {
    writeNativeChatDraftCache('tab-0:leaf-0', 'o mais antigo')
    expect(hasAgentUnsentDraft('tab-0:leaf-0')).toBe(true)

    for (let index = 1; index <= NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX; index += 1) {
      writeNativeChatDraftCache(`tab-${index}:leaf-${index}`, `rascunho ${index}`)
    }

    expect(hasAgentUnsentDraft('tab-0:leaf-0')).toBe(false)
    expect(hasAgentUnsentDraft('tab-1:leaf-1')).toBe(true)
  })
})
