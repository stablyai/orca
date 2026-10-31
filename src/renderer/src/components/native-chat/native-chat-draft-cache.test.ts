// @vitest-environment happy-dom
import type * as DraftStore from './native-chat-composer-draft-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from '../../../../shared/native-chat/native-chat-scope-cache'

afterEach(() => {
  clearNativeChatDraftCacheForTests()
})

describe('native-chat draft cache', () => {
  it('keeps every draft however many there are, since a draft that is pushed out is lost', () => {
    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 40
    for (let i = 0; i < total; i += 1) {
      writeNativeChatDraftCache(`scope-${i}`, `draft-${i}`)
    }

    expect(readNativeChatDraftCache('scope-0')).toBe('draft-0')
    expect(readNativeChatDraftCache(`scope-${total - 1}`)).toBe(`draft-${total - 1}`)
  })
})

import {
  createMemoryNativeChatComposerDraftStorage,
  type NativeChatComposerDraftStorage
} from './native-chat-composer-draft-storage'

describe('setup storage continuity', () => {
  const loaded: (typeof DraftStore)[] = []
  let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
  async function reload(
    options: { using?: NativeChatComposerDraftStorage; hydrate?: boolean } = {}
  ) {
    vi.resetModules()
    const storageModule = await import('./native-chat-composer-draft-storage')
    storage ??= createMemoryNativeChatComposerDraftStorage()
    storageModule.setNativeChatComposerDraftStorageForTests(options.using ?? storage)
    const store = await import('./native-chat-composer-draft-store')
    loaded.push(store)
    if (options.hydrate !== false) {
      await store.hydrateNativeChatComposerDrafts()
    }
    return { store }
  }
  afterEach(() => {
    for (const store of loaded.splice(0)) {
      store.clearNativeChatComposerDraftsForTests()
    }
    vi.restoreAllMocks()
    storage = createMemoryNativeChatComposerDraftStorage()
  })
  it.each([
    { targetEdited: false, refuse: false },
    { targetEdited: true, refuse: false },
    { targetEdited: true, refuse: true }
  ])(
    'accepted setup handoff joins delayed storage and current input, $targetEdited/$refuse',
    async ({ targetEdited, refuse }) => {
      storage = createMemoryNativeChatComposerDraftStorage()
      const sourceKey = 'agent-setup:["ssh:old","repo::/x","codex"]'
      const targetKey = 'agent-setup:["ssh:new","repo::/x","codex"]'
      storage.drafts.set(sourceKey, {
        text: 'saved source',
        images: [{ id: 'source-image', path: '/source.png' }],
        savedAt: 1,
        owner: { workspaceId: 'repo::/x', executionHostId: 'ssh:old' }
      })
      storage.drafts.set(targetKey, {
        text: 'saved target',
        images: [],
        savedAt: 2,
        owner: { workspaceId: 'repo::/x', executionHostId: 'ssh:new' }
      })
      const loaded = Promise.withResolvers<ReadonlyMap<string, unknown>>()
      const saved = new Map(storage.drafts)
      const instance = await reload({
        using: { ...storage, loadAll: () => loaded.promise },
        hydrate: false
      })
      storage.refuseWrites = refuse
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const loading = instance.store.hydrateNativeChatComposerDrafts()
      const from = instance.store.nativeChatLaunchPromptDraftScopeKey(
        'repo::/x',
        'codex',
        'ssh:old'
      )
      const to = instance.store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:new')
      if (targetEdited) {
        instance.store.updateNativeChatComposerDraft(to, { text: 'current target' }, 'immediate')
      }
      const { createTestStore } = await import('@/store/slices/store-test-helpers')
      const state = createTestStore()
      state
        .getState()
        .recordSshRepoReadoptions([{ oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }])
      loaded.resolve(saved)
      await loading
      await instance.store.nativeChatComposerDraftWritesSettled()
      expect(instance.store.readNativeChatComposerDraft(to).text).toBe(
        `${targetEdited ? 'current target' : 'saved target'}\n\nsaved source`
      )
      expect(instance.store.readNativeChatComposerDraft(from)).toBe(
        instance.store.readNativeChatComposerDraft(to)
      )
      expect(instance.store.readNativeChatComposerDraft(to).images).toEqual([
        { id: 'source-image', path: '/source.png' }
      ])
      if (refuse) {
        expect(instance.store.hasUnsavedNativeChatComposerDraftChange(to)).toBe(true)
        window.dispatchEvent(new Event('pagehide'))
        await instance.store.nativeChatComposerDraftWritesSettled()
        storage.refuseWrites = false
        instance.store.flushNativeChatComposerDrafts()
        await instance.store.nativeChatComposerDraftWritesSettled()
      }
      expect(storage.drafts.has(sourceKey)).toBe(false)
      expect(storage.drafts.get(targetKey)?.text).toBe(
        `${targetEdited ? 'current target' : 'saved target'}\n\nsaved source`
      )
      warning.mockRestore()
      const restarted = await reload()
      expect(
        restarted.store.readNativeChatComposerDraft(
          restarted.store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:new')
        ).text
      ).toContain('saved source')
    }
  )
})
