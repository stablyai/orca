// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatNativeChatAnnotations,
  getNativeChatAnnotationsStore
} from './native-chat-annotations-store'

const anchor = { quote: 'selected words', messageId: 'assistant-1', startOffset: 12 }

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('native chat annotation storage', () => {
  it('reloads saved notes, edits and deletions from storage in a new module', async () => {
    const store = getNativeChatAnnotationsStore('persistent')
    const first = store.add(anchor, 'explain this')
    const second = store.add(anchor, 'another point')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (!first || !second) {
      throw new Error('Notes were not accepted')
    }
    expect(first).toMatchObject({ ...anchor, comment: 'explain this' })
    expect(store.update(first.id, 'revised request')).toBe(true)
    const updated = store.getSnapshot().notes.find((note) => note.id === first.id)
    expect(updated?.revision).not.toBe(first.revision)
    expect(store.remove(second.id)).toBe(true)
    vi.resetModules()
    const fresh = await import('./native-chat-annotations-store')
    const restored = fresh.getNativeChatAnnotationsStore('persistent')
    expect(restored.getSnapshot().notes).toEqual([updated])
    expect(restored.clear()).toBe(true)
    vi.resetModules()
    const reloaded = await import('./native-chat-annotations-store')
    expect(reloaded.getNativeChatAnnotationsStore('persistent').getSnapshot().notes).toEqual([])
  })

  it('keeps conversation identities separate and rejects missing scopes and blank comments', () => {
    const a = getNativeChatAnnotationsStore('isolation-a')
    const b = getNativeChatAnnotationsStore('isolation-b')
    const note = a.add(anchor, 'only a')
    expect(b.getSnapshot().notes).toEqual([])
    expect(a.getSnapshot().notes).toEqual([note])
    expect(a.add(anchor, '  ')).toBeNull()
    expect(a.update('missing', 'text')).toBe(false)
    expect(a.remove('missing')).toBe(false)
    expect(getNativeChatAnnotationsStore(undefined).add(anchor, 'text')).toBeNull()
    expect(getNativeChatAnnotationsStore(undefined).getSnapshot().notes).toEqual([])
  })

  it('retains unsaved additions and edits across store access and retries after storage recovers', () => {
    const store = getNativeChatAnnotationsStore('write-failure')
    const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError')
    })
    const note = store.add(anchor, 'keep me')
    if (!note) {
      throw new Error('Note was not accepted')
    }
    expect(store.update(note.id, 'edited while full')).toBe(true)
    expect(store.getSnapshot().persistenceError).toBe('Storage is full')
    expect(getNativeChatAnnotationsStore('write-failure').getSnapshot().notes).toMatchObject([
      { ...anchor, id: note.id, comment: 'edited while full' }
    ])
    expect(store.retryPersistence()).toBe(false)
    storage.mockRestore()
    expect(store.retryPersistence()).toBe(true)
    expect(store.getSnapshot().persistenceError).toBeUndefined()
    expect(
      localStorage.getItem(`orca:native-chat-annotations:v2:write-failure:note:${note.id}`)
    ).toContain('edited while full')
  })

  it('reports unreadable storage and still accepts notes in memory', () => {
    const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('Storage is blocked')
    })
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage is blocked')
    })
    const store = getNativeChatAnnotationsStore('read-failure')
    expect(store.getSnapshot().persistenceError).toBe('Storage is blocked')
    const note = store.add(anchor, 'keep this draft')
    expect(store.getSnapshot().notes).toEqual([note])
    read.mockRestore()
    write.mockRestore()
    expect(store.retryPersistence()).toBe(true)
  })

  it('formats each quote and comment without consuming notes', () => {
    const store = getNativeChatAnnotationsStore('format')
    store.add({ ...anchor, quote: 'first\nsecond' }, 'my comment')
    store.add(anchor, 'next comment')
    expect(formatNativeChatAnnotations(store.getSnapshot().notes)).toBe(
      '> first\n> second\n\nmy comment\n\n> selected words\n\nnext comment'
    )
    expect(store.getSnapshot().notes).toHaveLength(2)
    expect(formatNativeChatAnnotations([])).toBe('')
    expect(
      formatNativeChatAnnotations([{ quote: 'pending words', comment: 'not saved yet' }])
    ).toBe('> pending words\n\nnot saved yet')
  })

  it('persists editor changes with notes and keeps them when notes are added, edited or deleted', async () => {
    const store = getNativeChatAnnotationsStore('editor-persistence')
    const draft = { anchor, comment: '  unfinished comment\n' }
    expect(store.setEditor(draft)).toBe(true)
    const savedDraft = store.getSnapshot().editor
    expect(savedDraft?.revision).toEqual(expect.any(String))
    const note = store.add(anchor, 'saved note')
    if (!note) {
      throw new Error('Missing note')
    }
    expect(store.getSnapshot().editor).toEqual(savedDraft)
    expect(store.update(note.id, 'updated saved note')).toBe(true)
    expect(store.getSnapshot().editor).toEqual(savedDraft)
    const updatedNote = store.getSnapshot().notes[0]
    vi.resetModules()
    const fresh = await import('./native-chat-annotations-store')
    const restored = fresh.getNativeChatAnnotationsStore('editor-persistence')
    expect(restored.getSnapshot()).toEqual({
      notes: [updatedNote],
      editor: savedDraft
    })
    expect(restored.remove(note.id)).toBe(true)
    expect(restored.getSnapshot()).toEqual({ notes: [], editor: savedDraft })
    restored.setEditor({ ...draft, id: note.id, comment: '' })
    vi.resetModules()
    const reloaded = await import('./native-chat-annotations-store')
    expect(
      reloaded.getNativeChatAnnotationsStore('editor-persistence').getSnapshot()
    ).toMatchObject({
      notes: [],
      editor: { ...draft, id: note.id, comment: '' }
    })
  })

  it('clears only the editor with setEditor(undefined) and clears both with clear()', async () => {
    const store = getNativeChatAnnotationsStore('editor-clear')
    const note = store.add(anchor, 'saved note')
    store.setEditor({ anchor, comment: 'unfinished' })
    expect(store.setEditor(undefined)).toBe(true)
    vi.resetModules()
    const fresh = await import('./native-chat-annotations-store')
    const restored = fresh.getNativeChatAnnotationsStore('editor-clear')
    expect(restored.getSnapshot()).toEqual({ notes: [note] })
    restored.setEditor({ anchor, comment: 'next draft' })
    expect(restored.clear()).toBe(true)
    vi.resetModules()
    const reloaded = await import('./native-chat-annotations-store')
    expect(reloaded.getNativeChatAnnotationsStore('editor-clear').getSnapshot()).toEqual({
      notes: []
    })
  })

  it('loads old notes-only records and reports invalid saved editor data', async () => {
    const store = getNativeChatAnnotationsStore('editor-legacy')
    const note = store.add(anchor, 'old note')
    localStorage.setItem(
      'orca:native-chat-annotations:v1:editor-invalid',
      JSON.stringify({
        version: 1,
        notes: [],
        editor: { anchor: { ...anchor, startOffset: -1 }, comment: 'bad' }
      })
    )
    vi.resetModules()
    const fresh = await import('./native-chat-annotations-store')
    expect(fresh.getNativeChatAnnotationsStore('editor-legacy').getSnapshot()).toEqual({
      notes: [note]
    })
    expect(fresh.getNativeChatAnnotationsStore('editor-invalid').getSnapshot()).toEqual({
      notes: [],
      persistenceError: 'Saved annotations could not be read.'
    })
  })

  it.each(['legacy', 'note', 'note-shape', 'editor'] as const)(
    'quarantines an unreadable %s record without blocking later saves',
    async (kind) => {
      const scope = `corrupt-${kind}`
      const store = getNativeChatAnnotationsStore(scope)
      const saved = store.add(anchor, 'Preserve the readable note')
      if (!saved) {
        throw new Error('Note was not accepted')
      }
      const prefix = `orca:native-chat-annotations:v2:${scope}:`
      const key =
        kind === 'legacy'
          ? `orca:native-chat-annotations:v1:${scope}`
          : kind === 'editor'
            ? `${prefix}editor`
            : `${prefix}note:broken`
      const unreadable = kind.endsWith('shape') || kind === 'editor' ? '{}' : '{invalid'
      localStorage.setItem(key, unreadable)
      vi.resetModules()
      const fresh = await import('./native-chat-annotations-store')
      const restored = fresh.getNativeChatAnnotationsStore(scope)
      expect(restored.getSnapshot()).toEqual({
        notes: [saved],
        persistenceError: 'Saved annotations could not be read.'
      })
      const quarantineKey = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index)
      ).find((entry) => entry?.startsWith(`${prefix}quarantine:${encodeURIComponent(key)}:`))
      expect(quarantineKey && localStorage.getItem(quarantineKey)).toBe(unreadable)
      expect(localStorage.getItem(key)).toBeNull()
      expect(restored.retryPersistence()).toBe(true)
      expect(restored.getSnapshot().persistenceError).toBeUndefined()
      expect(restored.update(saved.id, 'Updated after recovery')).toBe(true)
      const added = restored.add(anchor, 'New after recovery')
      expect(added).not.toBeNull()
      expect(restored.remove(saved.id)).toBe(true)
      expect(restored.consume(restored.getSnapshot().notes)).toBe(true)
      vi.resetModules()
      const reloaded = await import('./native-chat-annotations-store')
      expect(reloaded.getNativeChatAnnotationsStore(scope).getSnapshot()).toEqual({ notes: [] })
    }
  )

  it('keeps the unreadable original until its quarantine copy can be saved', () => {
    const scope = 'quarantine-write-failure'
    const key = `orca:native-chat-annotations:v1:${scope}`
    localStorage.setItem(key, '{invalid')
    const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage is full')
    })
    const store = getNativeChatAnnotationsStore(scope)
    store.add(anchor, 'Keep the pending note')
    expect(store.retryPersistence()).toBe(false)
    expect(localStorage.getItem(key)).toBe('{invalid')
    blocked.mockRestore()
    expect(store.retryPersistence()).toBe(false)
    expect(localStorage.getItem(key)).toBeNull()
    expect(store.retryPersistence()).toBe(true)
    expect(store.getSnapshot()).toMatchObject({
      notes: [{ comment: 'Keep the pending note' }]
    })
    expect(store.getSnapshot().persistenceError).toBeUndefined()
  })
})
