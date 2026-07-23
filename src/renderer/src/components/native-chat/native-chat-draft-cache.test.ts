import { afterEach, describe, expect, it } from 'vitest'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX,
  NATIVE_CHAT_SCOPE_CACHE_MAX_KEY_BYTES,
  NATIVE_CHAT_SCOPE_CACHE_MAX_VALUE_BYTES
} from './native-chat-composer-scope-cache'

afterEach(() => {
  clearNativeChatDraftCacheForTests()
})

describe('native-chat draft cache', () => {
  it('returns an empty string for an unknown scope', () => {
    expect(readNativeChatDraftCache('pty-1')).toBe('')
  })

  it('round-trips a draft per scope key', () => {
    writeNativeChatDraftCache('pty-1', 'hello')
    writeNativeChatDraftCache('pty-2', 'world')
    expect(readNativeChatDraftCache('pty-1')).toBe('hello')
    expect(readNativeChatDraftCache('pty-2')).toBe('world')
  })

  it('drops the entry when the draft is cleared so stale text never resurfaces', () => {
    writeNativeChatDraftCache('pty-1', 'hello')
    writeNativeChatDraftCache('pty-1', '')
    expect(readNativeChatDraftCache('pty-1')).toBe('')
  })

  it('retains a draft exactly at the production value limit', () => {
    const draft = 'x'.repeat(NATIVE_CHAT_SCOPE_CACHE_MAX_VALUE_BYTES)

    writeNativeChatDraftCache('pty-1', draft)

    expect(readNativeChatDraftCache('pty-1')).toBe(draft)
  })

  it('does not retain a draft one byte over the production value limit', () => {
    writeNativeChatDraftCache('pty-1', 'x'.repeat(NATIVE_CHAT_SCOPE_CACHE_MAX_VALUE_BYTES + 1))

    expect(readNativeChatDraftCache('pty-1')).toBe('')
  })

  it('does not retain a draft under an oversized multibyte scope key', () => {
    const scopeKey = '😀'.repeat(NATIVE_CHAT_SCOPE_CACHE_MAX_KEY_BYTES / 4 + 1)

    writeNativeChatDraftCache(scopeKey, 'still available to the mounted composer')

    expect(readNativeChatDraftCache(scopeKey)).toBe('')
  })

  it('bounds the cache so unsent drafts for removed panes cannot accumulate', () => {
    writeNativeChatDraftCache('keep', 'hot')

    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 40
    for (let i = 0; i < total; i += 1) {
      writeNativeChatDraftCache(`scope-${i}`, `draft-${i}`)
      if (i % 20 === 0) {
        writeNativeChatDraftCache('keep', 'hot')
      }
    }

    // Oldest untouched draft evicted; the actively-edited and most-recent survive.
    expect(readNativeChatDraftCache('scope-0')).toBe('')
    expect(readNativeChatDraftCache('keep')).toBe('hot')
    expect(readNativeChatDraftCache(`scope-${total - 1}`)).toBe(`draft-${total - 1}`)
  })
})
