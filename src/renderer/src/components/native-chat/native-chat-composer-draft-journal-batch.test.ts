// @vitest-environment happy-dom
// The shared journal's work while many hand-backs wait for their drafts' saved bases: one unload
// writes it once, and every scope's base read shares its load attempt's one journal snapshot.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as DraftStore from './native-chat-composer-draft-store'
import type * as DraftHandback from './native-chat-composer-draft-handback'
import type * as DraftCache from './native-chat-draft-cache'
import { createMemoryNativeChatComposerDraftStorage } from './native-chat-composer-draft-storage'

const JOURNAL_KEY = 'orca:nativeChatComposerDraftJournal:v1'
const A = 'Also run lint'
const B = 'Inspect the failing test and fix it'
const scopeOf = (index: number) => `agent-session:s${index}`
const receiptOf = (index: number) => ({ operationId: `op-${index}`, clientMessageId: `m-${index}` })

let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
const loaded: { store: typeof DraftStore }[] = []

beforeEach(() => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const instance of loaded.splice(0)) {
    instance.store.clearNativeChatComposerDraftsForTests()
  }
})

/** Shared-key work at the Storage boundary, before any filtering. */
function journalWork() {
  const work = { reads: 0, writes: 0, chars: 0 }
  const getItem = localStorage.getItem.bind(localStorage)
  const setItem = localStorage.setItem.bind(localStorage)
  const removeItem = localStorage.removeItem.bind(localStorage)
  vi.spyOn(localStorage, 'getItem').mockImplementation((key) => {
    work.reads += key === JOURNAL_KEY ? 1 : 0
    return getItem(key)
  })
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === JOURNAL_KEY) {
      work.writes += 1
      work.chars += value.length
    }
    setItem(key, value)
  })
  vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
    work.writes += key === JOURNAL_KEY ? 1 : 0
    removeItem(key)
  })
  return work
}

it.each([3, 30])(
  'unloads %i waiting hand-backs in one journal write and reads one snapshot for their bases',
  async (count) => {
    // Saved A for each chat, and an unrelated earlier run's journal for other panes.
    for (let index = 0; index < count; index++) {
      storage.drafts.set(scopeOf(index), { text: A, images: [], savedAt: 1 })
    }
    const corpus = Array.from({ length: count }, (_, index) => ({
      scopeKey: `tab-${index}:pane`,
      draft: { text: `unrelated ${index}`, images: [], savedAt: 2 },
      at: 2,
      run: 'earlier'
    }))
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(corpus))
    // A cold renderer whose global load and every draft's own base read are held.
    vi.resetModules()
    const storageModule = await import('./native-chat-composer-draft-storage')
    let land: () => void = () => {}
    let read: () => void = () => {}
    const reads = new Promise<void>((resolve) => (read = resolve))
    storageModule.setNativeChatComposerDraftStorageForTests({
      ...storage,
      loadAll: () => {
        const snapshot = new Map(storage.drafts)
        return new Promise((resolve) => (land = () => resolve(snapshot)))
      },
      update: async (...args) => (await reads, storage.update(...args))
    })
    const store: typeof DraftStore = await import('./native-chat-composer-draft-store')
    const handback: typeof DraftHandback = await import('./native-chat-composer-draft-handback')
    const drafts: typeof DraftCache = await import('./native-chat-draft-cache')
    loaded.push({ store })
    const work = journalWork()
    const loading = store.hydrateNativeChatComposerDrafts()
    // Bound: the load attempt reads the journal once, at its read boundary.
    expect(work.reads).toBe(1)
    for (let index = 0; index < count; index++) {
      handback.adoptIdentifiedNativeChatDraftInput(
        scopeOf(index),
        receiptOf(index),
        { text: B, images: [] },
        []
      )
      // Withheld until its base is read; what is typed meanwhile is the user's own.
      expect(store.readNativeChatComposerDraft(scopeOf(index)).text).toBe('')
      drafts.writeNativeChatDraftCache(scopeOf(index), `typed ${index}`)
    }

    const stringify = vi.spyOn(JSON, 'stringify')
    Object.assign(work, { reads: 0, writes: 0, chars: 0 })
    window.dispatchEvent(new Event('pagehide'))
    const unload = { ...work }
    const journal = localStorage.getItem(JOURNAL_KEY) ?? ''
    const entries = JSON.parse(journal)
    // Output: the unrelated corpus plus one identified addition per chat, holding what was typed.
    expect(entries).toHaveLength(2 * count)
    for (let index = 0; index < count; index++) {
      expect(entries).toContainEqual(
        expect.objectContaining({
          scopeKey: scopeOf(index),
          custody: { handback: receiptOf(index), sourcePaths: [] },
          addition: expect.objectContaining({ text: `typed ${index}\n\n${B}` })
        })
      )
    }
    // Bound: one read, one write of exactly the retained output, and at most two encodings per
    // participating entry (its sizing and the output reuse one encoding here).
    expect(unload).toEqual({ reads: 1, writes: 1, chars: journal.length })
    const encodedEntries = stringify.mock.calls.filter(
      ([value]) => typeof value === 'object' && value !== null && 'scopeKey' in value
    )
    expect(encodedEntries.length).toBeLessThanOrEqual(2 * entries.length)
    stringify.mockRestore()
    // Nothing changed since: another unload writes nothing.
    Object.assign(work, { reads: 0, writes: 0, chars: 0 })
    window.dispatchEvent(new Event('pagehide'))
    expect(work.writes).toBe(0)

    // Each draft's own base read replays from the attempt's snapshot, never a fresh journal read.
    // Bound: the reads left are each settled write's own prune: two writes per chat (the
    // adoption's, and the unload's flush of what was typed), one shared-key prune each.
    Object.assign(work, { reads: 0, writes: 0, chars: 0 })
    read()
    await store.nativeChatComposerDraftWritesSettled()
    expect(work.reads).toBeLessThanOrEqual(2 * count)
    for (let index = 0; index < count; index++) {
      expect(store.readNativeChatComposerDraft(scopeOf(index)).text).toBe(
        `${A}\n\ntyped ${index}\n\n${B}`
      )
    }
    land()
    await loading
    await store.nativeChatComposerDraftWritesSettled()
    for (let index = 0; index < count; index++) {
      expect(store.readNativeChatComposerDraft(scopeOf(index)).text).toBe(
        `${A}\n\ntyped ${index}\n\n${B}`
      )
      expect(storage.drafts.get(scopeOf(index))?.text).toBe(`${A}\n\ntyped ${index}\n\n${B}`)
    }
  }
)
