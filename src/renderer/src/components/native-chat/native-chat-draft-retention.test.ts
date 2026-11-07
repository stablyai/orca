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
import { createChatDraftRemovalReceipt } from '@/store/slices/worktrees/teardown/chat-draft-removal-receipt'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  clearNativeChatComposerDraftsForTests()
})
it('hydrates and removes verified closed members with one saved census at N and 10N', async () => {
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
    const inventories: { copies: number; entries: number; keys: number; gets: number }[] = []
    class SavedRecords extends Map<string, StoredNativeChatComposerDraft> {
      constructor(readonly visits: (typeof inventories)[number]) {
        super()
        for (const [key, value] of storage.drafts) {
          visits.copies++
          super.set(key, value)
        }
      }
      override *[Symbol.iterator](): Generator<[string, StoredNativeChatComposerDraft]> {
        for (const entry of super[Symbol.iterator]()) {
          this.visits.entries++
          yield entry
        }
      }
      override *keys(): MapIterator<string> {
        for (const key of super.keys()) {
          this.visits.keys++
          yield key
        }
      }
      override get(key: string) {
        this.visits.gets++
        return super.get(key)
      }
    }
    const load = vi.fn(async () => {
      const visits = { copies: 0, entries: 0, keys: 0, gets: 0 }
      inventories.push(visits)
      return new SavedRecords(visits)
    })
    const write = vi.fn(storage.write)
    const remove = vi.fn(storage.remove)
    let applies = 0
    const update = vi.fn(async (key: string, apply: Parameters<typeof storage.update>[1]) => {
      await storage.update(key, (stored) => {
        applies++
        return apply(stored)
      })
    })
    setNativeChatComposerDraftStorageForTests({ ...storage, loadAll: load, write, remove, update })
    await hydrateNativeChatComposerDrafts()
    expect(load).toHaveBeenCalledOnce()
    // Hydration retains each installed row's exact loaded input for later conditional cleanup.
    expect(inventories).toEqual([{ copies: count, entries: count, keys: 0, gets: count }])
    expect(records.size).toBe(count)
    const expectedIds = new Set(Array.from({ length: count / 2 }, (_, i) => `closed-${i * 2}`))
    let active = 0
    let peak = 0
    const locate = vi.fn(
      async ({ method, params }: { method: string; params: { address: string } }) => {
        expect(method).toBe('orchestration.partyLocation')
        const sessionId = params.address.slice('orca_session_id:'.length)
        expect(params.address).toBe(`orca_session_id:${sessionId}`)
        expect(expectedIds.has(sessionId)).toBe(true)
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        active--
        return {
          ok: true,
          result: { location: { kind: 'chat', sessionId, worktreeId: 'folder-workspace:kept' } }
        }
      }
    )
    vi.stubGlobal('window', { api: { runtime: { call: locate } } })
    const gets = vi.spyOn(records, 'get')
    const affected = vi.fn(),
      otherHost = vi.fn()
    const off = subscribeToNativeChatComposerDraft('agent-session:closed-0', affected)
    const offOther = subscribeToNativeChatComposerDraft('agent-session:closed-1', otherHost)
    const receipt = createChatDraftRemovalReceipt(() => ({ unifiedTabsByWorktree: {} }))
    receipt.capture({ executionHostId: 'local' })({ workspaceId: 'folder-workspace:kept' })
    await receipt.finish()
    await nativeChatComposerDraftWritesSettled()
    const lookupCount = gets.mock.calls.length
    gets.mockRestore()
    // One census plus four localized reads per positively selected destination.
    expect(lookupCount).toBeLessThanOrEqual(count * 3)
    expect(load).toHaveBeenCalledTimes(2)
    expect(inventories[1].copies).toBe(count)
    expect(inventories[1].keys + inventories[1].entries).toBeLessThanOrEqual(count)
    expect(inventories[1].gets).toBeLessThanOrEqual(count * 2)
    expect(locate).toHaveBeenCalledTimes(count / 2)
    expect(new Set(locate.mock.calls.map(([call]) => call.params.address))).toEqual(
      new Set([...expectedIds].map((id) => `orca_session_id:${id}`))
    )
    expect(peak).toBeLessThanOrEqual(8)
    expect(active).toBe(0)
    expect(records.size).toBe(count / 2)
    expect(storage.drafts.size).toBe(count / 2)
    expect(update).toHaveBeenCalledTimes(count / 2)
    expect(applies).toBe(count / 2)
    expect(new Set(update.mock.calls.map(([key]) => key))).toEqual(
      new Set([...expectedIds].map((id) => `agent-session:${id}`))
    )
    expect(remove).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    process.stdout.write(
      `${JSON.stringify({ metric: 'closed-member-removal', count, inventories, lookupCount, locators: locate.mock.calls.length, peak, commits: applies })}\n`
    )
    expect(affected).toHaveBeenCalledOnce()
    expect(otherHost).not.toHaveBeenCalled()
    expect(readNativeChatComposerDraft('agent-session:closed-1').text).toBe(
      `retained context 1\n${'text '.repeat(40)}`
    )
    off()
    offOther()
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    await nativeChatComposerDraftWritesSettled()
    for (let i = 0; i < count; i++) {
      expect(readNativeChatComposerDraft(`agent-session:closed-${i}`).text).toBe(
        i % 2 ? `retained context ${i}\n${'text '.repeat(40)}` : ''
      )
    }
  }
})
