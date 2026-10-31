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
  type NativeChatComposerDraftStorage,
  type StoredNativeChatComposerDraft
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
    vi.useRealTimers()
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
  const key = (host: string) => `agent-setup:["ssh:${host}","repo::/x","codex"]`
  const pasteId = (text: string) =>
    `00000000-0000-0000-0000-${text.charCodeAt(0).toString().padStart(12, '0')}`
  const rich = (text: string, path: string, ids: string[]) => ({
    text: `${text} [Pasted text](orca-paste:${pasteId(text)})`,
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text },
            { type: 'nativeChatSkill', attrs: { token: '$same', path } }
          ]
        }
      ]
    },
    pastedTextFiles: { [pasteId(text)]: `/paste/${text}.txt` },
    images: ids.map((id) => ({ id, path: `/${id}.png` })),
    savedAt: 1
  })
  async function heldMove(
    source: StoredNativeChatComposerDraft,
    target = rich('Y', '/y/SKILL.md', [])
  ) {
    storage = createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set(key('old'), {
      ...source,
      owner: { workspaceId: 'repo::/x', executionHostId: 'ssh:old' }
    })
    storage.drafts.set(key('new'), {
      ...target,
      owner: { workspaceId: 'repo::/x', executionHostId: 'ssh:new' }
    })
    const snapshot = new Map(storage.drafts)
    const gate = Promise.withResolvers<ReadonlyMap<string, unknown>>()
    const { store } = await reload({
      using: { ...storage, loadAll: () => gate.promise },
      hydrate: false
    })
    const loading = store.hydrateNativeChatComposerDrafts()
    const from = store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:old')
    const to = store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:new')
    const { createTestStore } = await import('@/store/slices/store-test-helpers')
    const state = createTestStore()
    const event = { oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }
    const accept = () => state.getState().recordSshRepoReadoptions([event])
    const settle = async () => {
      gate.resolve(snapshot)
      await loading
      await store.nativeChatComposerDraftWritesSettled()
    }
    return { store, from, to, accept, settle, state, event }
  }
  it.each([
    'source-exact',
    'source-owner',
    'source-clear',
    'target-exact',
    'target-owner',
    'target-before'
  ])(
    'ordinary authority admits the source before association and revokes current transfer: %s',
    async (action) => {
      const h = await heldMove(rich('X', '/x/SKILL.md', ['shared']))
      const owner = (host: 'old' | 'new') => ({
        workspaceId: 'repo::/x',
        executionHostId: `ssh:${host}` as const
      })
      if (action === 'source-exact') {
        h.store.deleteNativeChatComposerDraft(h.from)
      }
      if (action === 'source-owner') {
        h.store.deleteNativeChatComposerDraftsOwnedBy(owner('old'))
      }
      if (action === 'source-clear') {
        h.store.updateNativeChatComposerDraft(h.from, { text: 'Q' }, 'immediate')
        h.store.updateNativeChatComposerDraft(h.from, { text: '', images: [] }, 'immediate')
      }
      if (action === 'target-before') {
        h.store.deleteNativeChatComposerDraftsOwnedBy(owner('new'))
      }
      h.accept()
      if (action.startsWith('target-') && action !== 'target-before') {
        h.store.updateNativeChatComposerDraft(h.to, { text: 'edited Z' }, 'immediate')
        if (action === 'target-exact') {
          h.store.deleteNativeChatComposerDraft(h.to)
        } else {
          h.store.deleteNativeChatComposerDraftsOwnedBy(owner('new'))
        }
        h.store.updateNativeChatComposerDraft(h.to, { text: 'later Q' }, 'immediate')
      }
      await h.settle()
      const draft = h.store.readNativeChatComposerDraft(h.to)
      expect(draft.text.includes('X')).toBe(action === 'target-before')
      if (action.startsWith('source-')) {
        expect(draft.text).toContain('Y')
      }
      if (action === 'target-before') {
        expect(draft.text).not.toContain('Y')
      }
      if (action === 'target-exact' || action === 'target-owner') {
        expect(draft.text).toBe('later Q')
      }
      expect(storage.drafts.has(key('old'))).toBe(false)
      expect(storage.drafts.get(key('new'))?.text).toBe(draft.text)
      const restarted = await reload()
      expect(restarted.store.readNativeChatComposerDraft(key('new')).text).toBe(draft.text)
    }
  )
  it.each([false, true])(
    'joins exact rich source against live replacement, saved shared=%s',
    async (savedShared) => {
      const x = rich('X', '/x/SKILL.md', ['shared', 'only-x'])
      const z = rich('Z', '/z/SKILL.md', savedShared ? [] : ['shared', 'only-z'])
      const h = await heldMove(x, rich('Y', '/y/SKILL.md', savedShared ? ['shared'] : []))
      h.store.updateNativeChatComposerDraft(h.to, z, 'immediate')
      h.accept()
      await h.settle()
      const full = h.store.readNativeChatComposerDraft(h.to)
      expect(full.text).toBe(`${z.text}\n\n${x.text}`)
      expect(JSON.stringify(full.document)).toContain('/x/SKILL.md')
      expect(JSON.stringify(full.document)).toContain('/z/SKILL.md')
      expect(full.pastedTextFiles).toEqual({ ...z.pastedTextFiles, ...x.pastedTextFiles })
      expect(full.images.map((image) => image.id)).toEqual(
        savedShared ? ['shared', 'only-x'] : ['shared', 'only-z', 'only-x']
      )
      expect(storage.drafts.get(key('new'))).toEqual(full)
      h.state.getState().recordSshRepoReadoptions([{ ...h.event }])
      expect(h.store.readNativeChatComposerDraft(h.to)).toBe(full)
    }
  )
  it.each(['replacement', 'partial'])(
    'live %s joins unread saved target through actual update and load bases',
    async (kind) => {
      const x = rich('X', '/x/SKILL.md', ['shared'])
      const a = rich('A', '/a/SKILL.md', ['a'])
      const y = rich('Y', '/y/SKILL.md', ['shared'])
      const h = await heldMove(a, y)
      if (kind === 'replacement') {
        h.store.updateNativeChatComposerDraft(h.from, x, 'immediate')
      } else {
        h.store.appendToNativeChatComposerDraft(h.from, x)
      }
      await h.store.nativeChatComposerDraftWritesSettled()
      h.accept()
      expect(h.store.readNativeChatComposerDraft(h.to).text).toBe(x.text)
      await h.settle()
      const full = h.store.readNativeChatComposerDraft(h.to)
      expect(full.text).toBe(`${y.text}\n\n${x.text}${kind === 'partial' ? `\n\n${a.text}` : ''}`)
      expect(full.images.map((image) => image.id)).toEqual(
        kind === 'partial' ? ['shared', 'a'] : ['shared']
      )
      expect(full.pastedTextFiles).toEqual({
        ...y.pastedTextFiles,
        ...x.pastedTextFiles,
        ...(kind === 'partial' ? a.pastedTextFiles : {})
      })
      expect(JSON.stringify(full.document)).toContain('/x/SKILL.md')
      expect(storage.drafts.get(key('new'))).toEqual(full)
      expect(storage.drafts.has(key('old'))).toBe(false)
    }
  )
  it('retains image-only source when saved shared image was removed by a live replacement', async () => {
    const x = {
      ...rich('X', '/x/SKILL.md', ['shared']),
      text: '',
      document: undefined,
      pastedTextFiles: {}
    }
    const h = await heldMove(x, rich('Y', '/y/SKILL.md', ['shared']))
    h.store.updateNativeChatComposerDraft(h.to, { text: 'Z', images: [] }, 'immediate')
    h.accept()
    await h.settle()
    expect(h.store.readNativeChatComposerDraft(h.to).text).toBe('Z')
    expect(h.store.readNativeChatComposerDraft(h.to).images).toEqual(x.images)
    expect(storage.drafts.get(key('new'))).toEqual(h.store.readNativeChatComposerDraft(h.to))
  })
  it('resolves sequential accepted A→B→C before hydration to current initial owner, not intermediate owner', async () => {
    const h = await heldMove(rich('X', '/x/SKILL.md', ['shared']))
    h.accept()
    h.state
      .getState()
      .recordSshRepoReadoptions([{ oldTargetId: 'new', newTargetId: 'last', repoIds: ['repo'] }])
    await h.settle()
    const last = h.store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:last')
    const full = h.store.readNativeChatComposerDraft(last)
    expect(full.text).toContain('X')
    expect(full.text).toContain('Y')
    expect(full.owner).toEqual({ workspaceId: 'repo::/x', executionHostId: 'ssh:last' })
    h.store.deleteNativeChatComposerDraftsOwnedBy({
      workspaceId: 'repo::/x',
      executionHostId: 'ssh:new'
    })
    expect(h.store.readNativeChatComposerDraft(last)).toBe(full)
    expect(storage.drafts.get(key('last'))).toEqual(full)
    expect(storage.drafts.has(key('old'))).toBe(false)
    expect(storage.drafts.has(key('new'))).toBe(false)
    h.store.deleteNativeChatComposerDraftsOwnedBy({
      workspaceId: 'repo::/x',
      executionHostId: 'ssh:last'
    })
    await h.store.nativeChatComposerDraftWritesSettled()
    expect(h.store.readNativeChatComposerDraft(last).text).toBe('')
  })
  it.each([false, true])(
    'keeps saved source until confirmed flush, journal refused=%s',
    async (journalRefused) => {
      const h = await heldMove(rich('X', '/x/SKILL.md', ['shared']))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (journalRefused) {
        vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
          throw new DOMException('quota', 'QuotaExceededError')
        })
      }
      storage.refuseWrites = true
      h.store.updateNativeChatComposerDraft(h.from, { text: 'live X' }, 'immediate')
      h.accept()
      await h.settle()
      expect(storage.drafts.has(key('old'))).toBe(true)
      expect(h.store.readNativeChatComposerDraft(h.to).text).toContain('live X')
      expect(h.store.isNativeChatComposerDraftUnsaved(h.to)).toBe(true)
      expect(await h.store.nativeChatComposerDraftWriteSettled(key('new'))).toBe(false)
      expect(storage.drafts.has(key('old'))).toBe(true)
      storage.refuseWrites = false
      h.store.flushNativeChatComposerDrafts()
      await h.store.nativeChatComposerDraftWritesSettled()
      expect(storage.drafts.has(key('old'))).toBe(false)
      expect(storage.drafts.get(key('new'))?.text).toContain('live X')
      warn.mockRestore()
    }
  )
  it('late confirmed destination cannot erase new input or a later clear at the original raw address', async () => {
    const h = await heldMove(rich('X', '/x/SKILL.md', ['shared']))
    h.accept()
    h.store.updateNativeChatComposerDraft(key('old'), { text: 'new occupant' }, 'immediate')
    await h.settle()
    expect(storage.drafts.get(key('old'))?.text).toBe('new occupant')
    expect(h.store.readNativeChatComposerDraft(h.to).text).toContain('X')
    h.store.updateNativeChatComposerDraft(key('old'), { text: '', images: [] }, 'immediate')
    await h.store.nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.has(key('old'))).toBe(false)
    expect(h.store.readNativeChatComposerDraft(h.to).text).toContain('X')
  })

  it.each(['old-edited', 'target-deleted', 'chain'])(
    'actual held full write retires only current operation authority: %s',
    async (action) => {
      const h = await heldMove(rich('X', '/x/SKILL.md', ['shared']))
      const backend = (
        await import('./native-chat-composer-draft-storage')
      ).nativeChatComposerDraftStorage()
      const committed = Promise.withResolvers<void>()
      const issued = Promise.withResolvers<void>()
      const write = backend.write,
        update = backend.update,
        remove = backend.remove
      let queue = Promise.resolve()
      const enqueue = (operation: () => Promise<void>) => {
        const result = queue.then(operation)
        queue = result.catch(() => {})
        return result
      }
      let held = false
      vi.spyOn(backend, 'write').mockImplementation((scope, draft) =>
        enqueue(async () => {
          if (!held && scope === key('new')) {
            held = true
            issued.resolve()
            await committed.promise
          }
          await write(scope, draft)
        })
      )
      vi.spyOn(backend, 'update').mockImplementation((scope, apply) =>
        enqueue(() => update(scope, apply))
      )
      vi.spyOn(backend, 'remove').mockImplementation((scopes) => enqueue(() => remove(scopes)))
      h.accept()
      const settling = h.settle()
      await issued.promise
      expect(storage.drafts.has(key('old'))).toBe(true)
      expect(backend.remove).not.toHaveBeenCalledWith([key('old')])
      if (action === 'old-edited') {
        h.store.updateNativeChatComposerDraft(key('old'), { text: 'new old occupant' }, 'immediate')
      }
      if (action === 'target-deleted') {
        h.store.deleteNativeChatComposerDraft(h.to)
        h.store.updateNativeChatComposerDraft(h.to, { text: 'new target occupant' }, 'immediate')
      }
      if (action === 'chain') {
        h.state
          .getState()
          .recordSshRepoReadoptions([
            { oldTargetId: 'new', newTargetId: 'last', repoIds: ['repo'] }
          ])
      }
      committed.resolve()
      await settling
      expect(h.store.readNativeChatComposerDraft(h.to).text).toContain(
        action === 'target-deleted' ? 'new target occupant' : 'X'
      )
      expect(storage.drafts.get(key('old'))?.text).toBe(
        action === 'old-edited' ? 'new old occupant' : undefined
      )
      if (action === 'chain') {
        expect(storage.drafts.has(key('new'))).toBe(false)
        expect(storage.drafts.get(key('last'))?.text).toContain('X')
      }
    }
  )

  it.each(['replacement', 'partial', 'no-op'])(
    'retry rereads actual storage after accepted %s source mutation',
    async (kind) => {
      vi.useFakeTimers()
      storage = createMemoryNativeChatComposerDraftStorage()
      const x = rich('X', '/x/SKILL.md', ['shared'])
      const a = rich('A', '/a/SKILL.md', ['a'])
      const y = rich('Y', '/y/SKILL.md', ['shared'])
      storage.drafts.set(key('old'), a)
      storage.drafts.set(key('new'), y)
      const loadAll = vi
        .fn()
        .mockRejectedValueOnce(new Error('first open refused'))
        .mockImplementation(() => storage.loadAll())
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { store } = await reload({ using: { ...storage, loadAll }, hydrate: false })
      await store.hydrateNativeChatComposerDrafts()
      const from = store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:old')
      const to = store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:new')
      if (kind === 'replacement') {
        store.updateNativeChatComposerDraft(from, x, 'immediate')
      } else if (kind === 'partial') {
        store.appendToNativeChatComposerDraft(from, x)
      } else {
        store.updateNativeChatComposerDraft(from, { text: '', images: [] }, 'immediate')
      }
      await store.nativeChatComposerDraftWritesSettled()
      const { createTestStore } = await import('@/store/slices/store-test-helpers')
      createTestStore()
        .getState()
        .recordSshRepoReadoptions([{ oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }])
      await store.nativeChatComposerDraftWritesSettled()
      expect(storage.drafts.has(key('old'))).toBe(true)
      await vi.advanceTimersByTimeAsync(1000)
      await store.hydrateNativeChatComposerDrafts()
      await store.nativeChatComposerDraftWritesSettled()
      expect(loadAll).toHaveBeenCalledTimes(2)
      const full = store.readNativeChatComposerDraft(to)
      expect(full.text).toBe(
        kind === 'replacement'
          ? `${y.text}\n\n${x.text}`
          : kind === 'partial'
            ? `${y.text}\n\n${x.text}\n\n${a.text}`
            : `${y.text}\n\n${a.text}`
      )
      expect(storage.drafts.get(key('new'))).toEqual(full)
      expect(storage.drafts.has(key('old'))).toBe(false)
      store.updateNativeChatComposerDraft(to, { text: `${full.text} later` }, 'immediate')
      await store.nativeChatComposerDraftWritesSettled()
      const restarted = await reload()
      expect(restarted.store.readNativeChatComposerDraft(key('new'))).toEqual(
        storage.drafts.get(key('new'))
      )
      expect(restarted.store.readNativeChatComposerDraft(key('new')).text).toBe(
        `${full.text} later`
      )
    }
  )
})
