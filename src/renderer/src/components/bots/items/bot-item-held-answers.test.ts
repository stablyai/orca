// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { createMemoryNativeChatComposerDraftStorage } from '../../native-chat/drafts/native-chat-composer-draft-storage'

const storage = createMemoryNativeChatComposerDraftStorage()

/** A fresh renderer: module memory is gone, the drafts' storage is not. */
async function freshRenderer() {
  vi.resetModules()
  const storageModule = await import('../../native-chat/drafts/native-chat-composer-draft-storage')
  storageModule.setNativeChatComposerDraftStorageForTests(storage)
  const held = await import('./bot-item-held-answers')
  const load = await import('../../native-chat/drafts/native-chat-composer-draft-load')
  await load.hydrateNativeChatComposerDrafts()
  return held
}

it('keeps each held answer, its images too, on its own line across a reload', async () => {
  const before = await freshRenderer()
  before.holdBotItemAnswer('bot-item-answers:b:u:e1:0', { words: 'typed', paths: [] })
  before.holdBotItemAnswer('bot-item-answers:b:u:e1:1', {
    words: 'see [Image #1]',
    paths: ['/kept.png']
  })
  await vi.waitFor(() => expect(storage.drafts.size).toBe(2))

  const after = await freshRenderer()

  expect(after.readBotItemHeldAnswer('bot-item-answers:b:u:e1:0')).toEqual({
    words: 'typed',
    paths: []
  })
  expect(after.readBotItemHeldAnswer('bot-item-answers:b:u:e1:1')).toEqual({
    words: 'see [Image #1]',
    paths: ['/kept.png']
  })
  expect(after.readBotItemHeldAnswer('bot-item-answers:b:u:e1:2')).toBeNull()
})
