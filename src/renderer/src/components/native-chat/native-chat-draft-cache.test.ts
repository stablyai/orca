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

describe('setup current-memory continuity', () => {
  const loaded: (typeof DraftStore)[] = []
  let storage = createMemoryNativeChatComposerDraftStorage()
  async function reload(using: NativeChatComposerDraftStorage = storage) {
    vi.resetModules()
    const storageModule = await import('./native-chat-composer-draft-storage')
    storageModule.setNativeChatComposerDraftStorageForTests(using)
    const store = await import('./native-chat-composer-draft-store')
    loaded.push(store)
    return store
  }
  afterEach(() => {
    for (const store of loaded.splice(0)) {
      store.clearNativeChatComposerDraftsForTests()
    }
    vi.restoreAllMocks()
    vi.useRealTimers()
    localStorage.clear()
    storage = createMemoryNativeChatComposerDraftStorage()
  })
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
  async function heldMove() {
    const residue = rich('R', '/residue/SKILL.md', ['shared'])
    storage.drafts.set(key('old'), residue)
    storage.drafts.set(key('new'), residue)
    const snapshot = new Map(storage.drafts)
    const gate = Promise.withResolvers<ReadonlyMap<string, unknown>>()
    const write = vi.fn(storage.write),
      update = vi.fn(storage.update),
      remove = vi.fn(storage.remove)
    const store = await reload({ ...storage, write, update, remove, loadAll: () => gate.promise })
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
    return { store, from, to, accept, settle, state, event, write, update, remove, residue }
  }
  it.each(['edit', 'clear', 'delete'])(
    'an earlier held load cannot overwrite the synchronous accepted result or later %s',
    async (later) => {
      const h = await heldMove()
      const x = rich('X', '/x/SKILL.md', ['shared', 'only-x'])
      const y = rich('Y', '/y/SKILL.md', ['shared', 'only-y'])
      h.store.updateNativeChatComposerDraft(h.from, x, 'deferred')
      h.store.updateNativeChatComposerDraft(h.to, y, 'immediate')
      h.accept()
      const joined = h.store.readNativeChatComposerDraft(h.to)
      expect(joined.text).toBe(`${y.text}\n\n${x.text}`)
      expect(joined.pastedTextFiles).toEqual({ ...y.pastedTextFiles, ...x.pastedTextFiles })
      expect(joined.images).toEqual([...y.images, x.images[1]])
      expect(JSON.stringify(joined.document)).toContain('/x/SKILL.md')
      expect(JSON.stringify(joined.document)).toContain('/y/SKILL.md')
      h.store.updateNativeChatComposerDraft(
        key('old'),
        rich('Q', '/q/SKILL.md', ['q']),
        'immediate'
      )
      const z = rich('Z', '/z/SKILL.md', ['z'])
      h.store.updateNativeChatComposerDraft(h.to, z, 'immediate')
      if (later === 'clear') {
        h.store.updateNativeChatComposerDraft(h.to, { text: '', images: [] }, 'immediate')
      }
      if (later === 'delete') {
        h.store.deleteNativeChatComposerDraft(h.to)
      }
      const current = h.store.readNativeChatComposerDraft(h.to)
      await h.settle()
      window.dispatchEvent(new Event('pagehide'))
      await h.store.nativeChatComposerDraftWritesSettled()
      expect(h.store.readNativeChatComposerDraft(h.to)).toBe(current)
      expect(current.text).toBe(later === 'edit' ? z.text : '')
      expect(h.store.readNativeChatComposerDraft(key('old')).text).toContain('Q')
      h.state.getState().recordSshRepoReadoptions([{ ...h.event }])
      expect(h.store.readNativeChatComposerDraft(h.to)).toBe(current)
      expect(h.write).not.toHaveBeenCalled()
      expect(h.update).not.toHaveBeenCalled()
      expect(h.remove).toHaveBeenCalledTimes(later === 'delete' ? 1 : 0)
      const journal = JSON.parse(
        localStorage.getItem('orca:nativeChatComposerDraftJournal:v1') ?? '[]'
      )
      expect(journal.every((entry: { draft?: unknown }) => entry.draft === null)).toBe(true)
      const restarted = await reload()
      await restarted.hydrateNativeChatComposerDrafts()
      expect(restarted.readNativeChatComposerDraft(key('new')).text).toBe('')
      expect(restarted.readNativeChatComposerDraft(key('old')).text).toBe('')
    }
  )
  it.each(['source-exact', 'source-owner', 'source-clear', 'target-exact', 'target-owner'])(
    'reached ordinary %s acts on current live input, never unread residue',
    async (action) => {
      const h = await heldMove()
      h.store.updateNativeChatComposerDraft(h.from, rich('X', '/x/SKILL.md', ['x']), 'immediate')
      h.store.updateNativeChatComposerDraft(h.to, rich('Y', '/y/SKILL.md', ['y']), 'immediate')
      if (action === 'source-exact') {
        h.store.deleteNativeChatComposerDraft(h.from)
      }
      if (action === 'source-owner') {
        h.store.deleteNativeChatComposerDraftsOwnedBy({
          workspaceId: 'repo::/x',
          executionHostId: 'ssh:old'
        })
      }
      if (action === 'source-clear') {
        h.store.updateNativeChatComposerDraft(h.from, { text: '', images: [] }, 'immediate')
      }
      h.accept()
      if (action === 'target-exact') {
        h.store.deleteNativeChatComposerDraft(h.to)
      }
      if (action === 'target-owner') {
        h.store.deleteNativeChatComposerDraftsOwnedBy({
          workspaceId: 'repo::/x',
          executionHostId: 'ssh:new'
        })
      }
      await h.settle()
      const full = h.store.readNativeChatComposerDraft(h.to)
      expect(full.text).toBe(
        action.startsWith('source-') ? rich('Y', '/y/SKILL.md', ['y']).text : ''
      )
      expect(full.images.map(({ id }) => id)).toEqual(action.startsWith('source-') ? ['y'] : [])
      expect(full.text).not.toContain('R')
      expect(h.write).not.toHaveBeenCalled()
      expect(h.update).not.toHaveBeenCalled()
    }
  )
  it.each([false, true])(
    'current image membership overrides saved disagreement (%s), with live direct A→B→C',
    async (savedShared) => {
      const h = await heldMove()
      const x = rich('X', '/x/SKILL.md', ['shared', 'only-x'])
      const z = rich('Z', '/z/SKILL.md', savedShared ? [] : ['shared', 'only-z'])
      h.store.appendToNativeChatComposerDraft(h.from, x)
      h.store.updateNativeChatComposerDraft(h.to, z, 'immediate')
      h.accept()
      h.state
        .getState()
        .recordSshRepoReadoptions([{ oldTargetId: 'new', newTargetId: 'last', repoIds: ['repo'] }])
      await h.settle()
      const full = h.store.readNativeChatComposerDraft(h.from)
      expect(full).toBe(h.store.readNativeChatComposerDraft(key('last')))
      expect(full.text).toBe(`${z.text}\n\n${x.text}`)
      expect(full.pastedTextFiles).toEqual({ ...z.pastedTextFiles, ...x.pastedTextFiles })
      expect(full.images.map(({ id }) => id)).toEqual(
        savedShared ? ['shared', 'only-x'] : ['shared', 'only-z', 'only-x']
      )
      expect(JSON.stringify(full.document)).toContain('/x/SKILL.md')
      expect(JSON.stringify(full.document)).toContain('/z/SKILL.md')
      expect(full.owner).toEqual({ workspaceId: 'repo::/x', executionHostId: 'ssh:last' })
      h.store.deleteNativeChatComposerDraftsOwnedBy({
        workspaceId: 'repo::/x',
        executionHostId: 'ssh:new'
      })
      expect(h.store.readNativeChatComposerDraft(h.from)).toBe(full)
      expect(h.write).not.toHaveBeenCalled()
      expect(h.update).not.toHaveBeenCalled()
      expect(h.remove).not.toHaveBeenCalled()
    }
  )
  it.each([false, true])(
    'failed initial load/retry excludes old stored X and independent new raw/scoped Q, refused storage=%s',
    async (refused) => {
      vi.useFakeTimers()
      storage.drafts.set(key('old'), rich('R', '/residue/SKILL.md', ['residue']))
      storage.drafts.set(key('new'), rich('S', '/saved-target/SKILL.md', ['saved-target']))
      const loadAll = vi
        .fn()
        .mockRejectedValueOnce(new Error('first open refused'))
        .mockImplementation(storage.loadAll)
      const write = vi.fn(storage.write),
        update = vi.fn(storage.update),
        remove = vi.fn(storage.remove)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const store = await reload({ ...storage, loadAll, write, update, remove })
      await store.hydrateNativeChatComposerDrafts()
      const from = store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:old')
      const { createTestStore, TEST_REPO } = await import('@/store/slices/store-test-helpers')
      const state = createTestStore()
      state.setState({
        repos: [{ ...TEST_REPO, id: 'repo', executionHostId: 'ssh:new', connectionId: 'new' }],
        worktreesByRepo: { repo: [] }
      })
      store.updateNativeChatComposerDraft(from, rich('X', '/x/SKILL.md', ['live-x']), 'immediate')
      const capture = store.captureNativeChatComposerSubmission(from)
      store.updateNativeChatComposerDraft(from, { text: '', images: [] }, 'immediate')
      state
        .getState()
        .recordSshRepoReadoptions([{ oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }])
      storage.refuseWrites = refused
      const q = rich('Q', '/q/SKILL.md', ['q'])
      store.updateNativeChatComposerDraft(key('old'), q, 'immediate')
      const fresh = store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:old')
      expect(store.readNativeChatComposerDraft(fresh).text).toBe(q.text)
      await vi.advanceTimersByTimeAsync(1000)
      expect(loadAll).toHaveBeenCalledTimes(2)
      const to = store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:new')
      expect(store.readNativeChatComposerDraft(to).text).toBe('')
      store.finishNativeChatComposerSubmission(from, capture, true)
      expect(store.readNativeChatComposerDraft(to).text).toBe(
        rich('X', '/x/SKILL.md', ['live-x']).text
      )
      expect(store.readNativeChatComposerDraft(to).images.map(({ id }) => id)).toEqual(['live-x'])
      expect(store.readNativeChatComposerDraft(fresh).text).toBe(q.text)
      expect(write).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(storage.drafts.get(key('old'))?.text).toContain('R')
    }
  )
  it('excludes setup disk and every journal kind before acquisition/effects, retaining ordinary and queued hydration', async () => {
    const residue = rich('R', '/residue/SKILL.md', ['residue'])
    const raw = [
      key('old'),
      key('new'),
      'agent-setup:unreadable',
      'agent-setup:null',
      'agent-setup:addition'
    ]
    storage.drafts.set(raw[0], residue)
    storage.drafts.set(raw[1], { ...residue, savedAt: 100 })
    const journalKey = 'orca:nativeChatComposerDraftJournal:v1'
    const journal = [
      { scopeKey: raw[1], at: 1, draft: residue },
      { scopeKey: raw[3], at: 2, draft: null },
      { scopeKey: raw[4], at: 3, addition: residue },
      {
        scopeKey: 'agent-session:ordinary',
        at: 4,
        draft: rich('O', '/ordinary/SKILL.md', ['ordinary'])
      },
      { scopeKey: 'queued-edit:existing', at: 5, draft: rich('E', '/edit/SKILL.md', ['edit']) }
    ]
    localStorage.setItem(journalKey, JSON.stringify(journal))
    const snapshot = new Map<string, unknown>(storage.drafts)
    snapshot.set(raw[2], { corrupt: true })
    const write = vi.fn(storage.write),
      update = vi.fn(storage.update),
      remove = vi.fn(storage.remove)
    const store = await reload({ ...storage, write, update, remove, loadAll: async () => snapshot })
    await store.hydrateNativeChatComposerDrafts()
    await store.nativeChatComposerDraftWritesSettled()
    const memory = await import('./native-chat-composer-draft-memory')
    for (const scope of raw) {
      expect(store.readNativeChatComposerDraft(scope).text).toBe('')
      expect(memory.restoredImageChecks.has(scope)).toBe(false)
      expect(memory.dirtyScopes.has(scope)).toBe(false)
    }
    expect(store.readNativeChatComposerDraft('agent-session:ordinary').text).toContain('O')
    expect(store.readNativeChatComposerDraft('queued-edit:existing').text).toContain('E')
    expect(write.mock.calls.map(([scope]) => scope)).toEqual([
      'agent-session:ordinary',
      'queued-edit:existing'
    ])
    expect(remove).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(
      JSON.parse(localStorage.getItem(journalKey) ?? '[]').filter((entry: { scopeKey: string }) =>
        raw.includes(entry.scopeKey)
      )
    ).toEqual(journal.slice(0, 3))
    expect(storage.drafts.get(raw[0])).toEqual(residue)
  })
  it.each(['flush', 'equality', 'pagehide'])(
    'refused deliberate deletion retries only null beside successor Q through %s',
    async (entry) => {
      const remove = vi.fn(storage.remove),
        write = vi.fn(storage.write),
        update = vi.fn(storage.update)
      const store = await reload({ ...storage, remove, write, update })
      await store.hydrateNativeChatComposerDrafts()
      const scope = store.nativeChatLaunchPromptDraftScopeKey('repo::/x', 'codex', 'ssh:new')
      store.updateNativeChatComposerDraft(scope, rich('X', '/x/SKILL.md', ['x']), 'immediate')
      remove.mockRejectedValueOnce(new DOMException('refused', 'QuotaExceededError'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      store.deleteNativeChatComposerDraft(scope)
      await store.nativeChatComposerDraftWritesSettled()
      const q = rich('Q', '/q/SKILL.md', ['q'])
      store.updateNativeChatComposerDraft(scope, q, 'deferred')
      const current = store.readNativeChatComposerDraft(scope)
      expect(store.isNativeChatComposerDraftUnsaved(scope)).toBe(false)
      const commit = Promise.withResolvers<void>()
      remove.mockImplementationOnce(async (keys) => {
        await commit.promise
        storage.refuseWrites = false
        await storage.remove(keys)
      })
      if (entry === 'flush') {
        store.flushNativeChatComposerDrafts()
      }
      if (entry === 'equality') {
        store.updateNativeChatComposerDraft(scope, q, 'immediate')
      }
      window.dispatchEvent(new Event('pagehide'))
      const raw = key('new')
      expect(
        JSON.parse(localStorage.getItem('orca:nativeChatComposerDraftJournal:v1') ?? '[]')
      ).toEqual([expect.objectContaining({ scopeKey: raw, draft: null })])
      commit.resolve()
      await store.nativeChatComposerDraftWritesSettled()
      expect(remove).toHaveBeenCalledTimes(2)
      expect(remove).toHaveBeenLastCalledWith([raw])
      expect(store.readNativeChatComposerDraft(scope)).toBe(current)
      expect(store.isNativeChatComposerDraftUnsaved(scope)).toBe(false)
      expect(storage.drafts.has(raw)).toBe(false)
      expect(write).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
      expect(localStorage.getItem('orca:nativeChatComposerDraftJournal:v1')).toBeNull()
    }
  )
})
