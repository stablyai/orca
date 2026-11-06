// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryNativeChatComposerDraftStorage } from './native-chat-composer-draft-storage'

let storage = createMemoryNativeChatComposerDraftStorage()
const cleanups: (() => void)[] = []

/** A fresh renderer over the same saved drafts. */
async function renderer(hydrate: boolean) {
  vi.resetModules()
  const storageModule = await import('./native-chat-composer-draft-storage')
  storageModule.setNativeChatComposerDraftStorageForTests(storage)
  const store = await import('./native-chat-composer-draft-store')
  const quotes = await import('./native-chat-selection-quote-draft')
  cleanups.push(() => store.clearNativeChatComposerDraftsForTests())
  if (hydrate) {
    await store.hydrateNativeChatComposerDrafts()
  }
  return { store, quotes }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  storage = createMemoryNativeChatComposerDraftStorage()
})

// Add to chat is typed input: a lone command stays and a second identical quote is a second quote.
describe('appendQuoteToChatDraft', () => {
  it('adds the quote after the draft every time, and saves it', async () => {
    const { store, quotes } = await renderer(true)
    store.updateNativeChatComposerDraft('agent-session:s1', { text: '/compact' }, 'immediate')
    quotes.appendQuoteToChatDraft('agent-session:s1', '> a\n\n')
    quotes.appendQuoteToChatDraft('agent-session:s1', '> a\n\n')
    await store.nativeChatComposerDraftWritesSettled()
    expect(store.readNativeChatComposerDraft('agent-session:s1').text).toBe(
      '/compact\n\n> a\n\n> a\n\n'
    )
    expect(storage.drafts.get('agent-session:s1')?.text).toBe('/compact\n\n> a\n\n> a\n\n')
  })

  it('adds after a saved draft that had not loaded yet', async () => {
    storage.drafts.set('agent-session:s2', { text: 'typed earlier', images: [], savedAt: 1 })
    const { store, quotes } = await renderer(false)
    quotes.appendQuoteToChatDraft('agent-session:s2', '> b\n\n')
    await store.hydrateNativeChatComposerDrafts()
    await store.nativeChatComposerDraftWritesSettled()
    expect(store.readNativeChatComposerDraft('agent-session:s2').text).toBe(
      'typed earlier\n\n> b\n\n'
    )
    expect(storage.drafts.get('agent-session:s2')?.text).toBe('typed earlier\n\n> b\n\n')
  })
})
