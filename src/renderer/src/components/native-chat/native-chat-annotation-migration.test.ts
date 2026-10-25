// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeChatAnnotationStorage } from './native-chat-annotation-storage'

const anchor = { messageId: 'reply', quote: 'Saved text', startOffset: 0 }
const note = { ...anchor, id: 'note', comment: 'Legacy note', createdAt: 1 }
const editor = { anchor, comment: 'Legacy editor' }
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

it.each(['note', 'editor'] as const)(
  'a paused %s migration cannot overwrite another context newer edit',
  (kind) => {
    const scope = `migration-interleaved-${kind}`
    const prefix = `orca:native-chat-annotations:v2:${scope}:`
    localStorage.setItem(
      `orca:native-chat-annotations:v1:${scope}`,
      JSON.stringify({ version: 1, notes: [note], editor })
    )
    const a = nativeChatAnnotationStorage(scope)
    const b = nativeChatAnnotationStorage(scope)
    const write = localStorage.setItem.bind(localStorage)
    let interleaved = false
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (!interleaved && key === `${prefix}legacy-${kind}${kind === 'note' ? ':note' : ''}`) {
        interleaved = true
        b.read()
        b.writeNote({ ...note, comment: 'New note from B', revision: 'new-note' })
        b.writeEditor({ ...editor, comment: 'New editor from B', revision: 'new-editor' })
      }
      write(key, value)
    })
    const result = a.read()
    expect(interleaved).toBe(true)
    expect(result.notes[0]?.comment).toBe('New note from B')
    expect(result.editor?.comment).toBe('New editor from B')
    expect(b.read()).toEqual(result)
  }
)

it('preserves new edits while a partial migration is retried after storage recovers', () => {
  const scope = 'migration-partial'
  localStorage.setItem(
    `orca:native-chat-annotations:v1:${scope}`,
    JSON.stringify({ version: 1, notes: [note], editor })
  )
  const storage = nativeChatAnnotationStorage(scope)
  const write = localStorage.setItem.bind(localStorage)
  const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.endsWith(':legacy-editor')) {
      throw new Error('Full')
    }
    write(key, value)
  })
  expect(storage.read()).toEqual({ notes: [note], editor, persistenceError: 'Full' })
  storage.writeNote({ ...note, comment: 'New before retry', revision: 'new' })
  storage.writeEditor({ ...editor, comment: 'New editor before retry', revision: 'new-editor' })
  blocked.mockRestore()
  const next = storage.read()
  expect(next.persistenceError).toBeUndefined()
  expect(next.notes[0]?.comment).toBe('New before retry')
  expect(next.editor?.comment).toBe('New editor before retry')
})

it('does not bring migrated seeds back after consuming the edited current records', () => {
  const scope = 'migration-consumed'
  localStorage.setItem(
    `orca:native-chat-annotations:v1:${scope}`,
    JSON.stringify({ version: 1, notes: [note], editor })
  )
  const storage = nativeChatAnnotationStorage(scope)
  storage.read()
  const updatedNote = { ...note, comment: 'Updated', revision: 'new-note' }
  const updatedEditor = { ...editor, comment: 'Updated', revision: 'new-editor' }
  storage.writeNote(updatedNote)
  storage.writeEditor(updatedEditor)
  storage.consumeNote(updatedNote)
  storage.consumeEditor(updatedEditor)
  expect(storage.read()).toEqual({ notes: [] })
})

it('keeps readable legacy notes and editor available when every migration write fails', async () => {
  const scope = 'migration-refused'
  const key = `orca:native-chat-annotations:v1:${scope}`
  localStorage.setItem(key, JSON.stringify({ version: 1, notes: [note], editor }))
  const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Full')
  })
  vi.resetModules()
  const store = (await import('./native-chat-annotations-store')).getNativeChatAnnotationsStore(
    scope
  )
  expect(store.getSnapshot()).toEqual({ notes: [note], editor, persistenceError: 'Full' })
  expect(store.retryPersistence()).toBe(false)
  expect(localStorage.getItem(key)).toContain('Legacy note')
  blocked.mockRestore()
  expect(store.retryPersistence()).toBe(true)
  expect(store.getSnapshot()).toEqual({ notes: [note], editor })
})
