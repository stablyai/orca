// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import { records } from './native-chat-composer-draft-memory'
import { deleteWorkspaceChatDrafts } from '@/store/slices/worktrees/teardown/removed-worktree-chat-drafts'

afterEach(() => {
  vi.restoreAllMocks()
  clearNativeChatComposerDraftsForTests()
})
it('hydrates and explicitly deletes retained closed drafts with linear saved-record work at N and 10N', async () => {
  for (const count of [100, 1000]) {
    clearNativeChatComposerDraftsForTests()
    localStorage.clear()
    const storage = createMemoryNativeChatComposerDraftStorage()
    for (let i = 0; i < count; i++) {
      storage.drafts.set(`agent-session:closed-${i}`, {
        text: `retained context ${i}\n${'text '.repeat(40)}`,
        images: [],
        owner: {
          workspaceId: 'folder-workspace:kept',
          executionHostId: i % 2 ? 'ssh:other' : 'local'
        },
        savedAt: i + 1
      })
    }
    let visits = 0
    class SavedRecords extends Map<string, StoredNativeChatComposerDraft> {
      override *[Symbol.iterator](): Generator<
        [string, StoredNativeChatComposerDraft],
        undefined,
        unknown
      > {
        for (const entry of super[Symbol.iterator]()) {
          visits++
          yield entry
        }
        return undefined
      }
    }
    const load = vi.fn(async () => new SavedRecords(storage.drafts))
    const write = vi.fn(storage.write)
    const remove = vi.fn(storage.remove)
    setNativeChatComposerDraftStorageForTests({ ...storage, loadAll: load, write, remove })
    await hydrateNativeChatComposerDrafts()
    expect(load).toHaveBeenCalledOnce()
    expect(visits).toBe(count)
    expect(records.size).toBe(count)
    const gets = vi.spyOn(records, 'get')
    const affected = vi.fn(),
      otherHost = vi.fn()
    const off = subscribeToNativeChatComposerDraft('agent-session:closed-0', affected)
    const offOther = subscribeToNativeChatComposerDraft('agent-session:closed-1', otherHost)
    deleteWorkspaceChatDrafts({
      owners: [{ workspaceId: 'folder-workspace:kept', executionHostId: 'local' }],
      conversations: [],
      terminalTabIds: []
    })
    // Owner selection reads each saved record once; persistence may read the selected keys again.
    expect(gets.mock.calls.length).toBeLessThanOrEqual(count * 2)
    await nativeChatComposerDraftWritesSettled()
    expect(records.size).toBe(count / 2)
    expect(storage.drafts.size).toBe(count / 2)
    expect(remove.mock.calls.flatMap(([keys]) => keys)).toHaveLength(count / 2)
    expect(write).not.toHaveBeenCalled()
    expect(affected).toHaveBeenCalledOnce()
    expect(otherHost).not.toHaveBeenCalled()
    expect(readNativeChatComposerDraft('agent-session:closed-1').text).toBe(
      `retained context 1\n${'text '.repeat(40)}`
    )
    off()
    offOther()
    gets.mockRestore()
  }
})
