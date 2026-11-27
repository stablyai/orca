import { afterEach, expect, it } from 'vitest'
import { hydrateNativeChatComposerDrafts } from './native-chat-composer-draft-load'
import { preparePendingChatDraftHandoff } from './native-chat-composer-draft-move'
import { nativeChatComposerDraftWritesSettled } from './native-chat-composer-draft-persistence'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from './native-chat-draft-reset'

afterEach(clearNativeChatComposerDraftsForTests)

it('recovers only the accepted launch from its durable source and consumes it once', async () => {
  const disk = createMemoryNativeChatComposerDraftStorage()
  const restart = async (): Promise<void> => {
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(disk)
    await hydrateNativeChatComposerDrafts()
    await nativeChatComposerDraftWritesSettled()
  }
  const pending = 'pending-worktree-creation:first'
  const unrelated = 'pending-worktree-creation:second'
  const foreign = 'pending-worktree-creation:third'
  const chat = 'agent-session:accepted-chat'
  const owner = { workspaceId: 'repo::/work', executionHostId: 'runtime:paired' } as const
  const image = { id: 'chart', path: '/chart.png' }
  await restart()
  updateNativeChatComposerDraft(pending, { text: 'Check the chart', images: [image] }, 'immediate')
  updateNativeChatComposerDraft(unrelated, { text: 'Another launch' }, 'immediate')
  updateNativeChatComposerDraft(foreign, { text: 'Other host' }, 'immediate')
  updateNativeChatComposerDraft(chat, { text: 'Already here', owner }, 'immediate')
  await preparePendingChatDraftHandoff(pending, 'accepted-chat', owner)
  await preparePendingChatDraftHandoff(foreign, 'accepted-chat', {
    ...owner,
    executionHostId: 'local'
  })
  // The process died after the destination was known, before any part of the move landed.
  await restart()
  expect(readNativeChatComposerDraft(chat)).toMatchObject({
    text: 'Already here\n\nCheck the chart',
    images: [image],
    owner
  })
  expect(disk.drafts.has(pending)).toBe(false)
  expect(readNativeChatComposerDraft(foreign).text).toBe('Other host')
  expect(readNativeChatComposerDraft(chat).text).not.toContain('Other host')
  updateNativeChatComposerDraft(chat, { text: '', images: [] }, 'immediate')
  await nativeChatComposerDraftWritesSettled()
  await restart()
  expect(readNativeChatComposerDraft(chat).text).toBe('')
  expect(readNativeChatComposerDraft(unrelated).text).toBe('Another launch')
})
