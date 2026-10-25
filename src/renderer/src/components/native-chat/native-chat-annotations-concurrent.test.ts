// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const anchor = { quote: 'selected words', messageId: 'reply', startOffset: 0 }
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

async function contexts(scope: string) {
  vi.resetModules()
  const a = (await import('./native-chat-annotations-store')).getNativeChatAnnotationsStore(scope)
  vi.resetModules()
  const b = (await import('./native-chat-annotations-store')).getNativeChatAnnotationsStore(scope)
  return { a, b }
}

it('preserves additions from two contexts, even when writes interleave after both reads', async () => {
  const { a, b } = await contexts('concurrent-add')
  const write = localStorage.setItem.bind(localStorage)
  let interleaved = false
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (!interleaved && key.includes(':note:')) {
      interleaved = true
      b.add(anchor, 'B')
    }
    write(key, value)
  })
  a.add(anchor, 'A')
  vi.resetModules()
  const restored = (await import('./native-chat-annotations-store')).getNativeChatAnnotationsStore(
    'concurrent-add'
  )
  expect(
    restored
      .getSnapshot()
      .notes.map((note) => note.comment)
      .sort()
  ).toEqual(['A', 'B'])
})

it('keeps unrelated notes while another context edits, deletes or transfers its own notes', async () => {
  const { a, b } = await contexts('concurrent-edits')
  const first = a.add(anchor, 'A')
  const second = b.add(anchor, 'B')
  if (!first || !second) {
    throw new Error('Missing notes')
  }
  const transferred = a.getSnapshot().notes
  b.update(first.id, 'A edited elsewhere')
  b.add(anchor, 'new after transfer began')
  a.consume(transferred)
  a.remove(second.id)
  vi.resetModules()
  const restored = (await import('./native-chat-annotations-store')).getNativeChatAnnotationsStore(
    'concurrent-edits'
  )
  expect(restored.getSnapshot().notes.map((note) => note.comment)).toEqual([
    'A edited elsewhere',
    'new after transfer began'
  ])
})

it('notifies a subscribed view when another window changes or deletes notes', async () => {
  const { a, b } = await contexts('storage-events')
  const changed = vi.fn()
  const unsubscribe = a.subscribe(changed)
  const note = b.add(anchor, 'B')
  if (!note) {
    throw new Error('Missing note')
  }
  const key = `orca:native-chat-annotations:v2:storage-events:note:${note.id}`
  window.dispatchEvent(new StorageEvent('storage', { key }))
  expect(a.getSnapshot().notes).toEqual([note])
  expect(changed).toHaveBeenCalledOnce()
  b.remove(note.id)
  window.dispatchEvent(new StorageEvent('storage', { key }))
  expect(a.getSnapshot().notes).toEqual([])
  unsubscribe()
})

it('migrates legacy notes and unfinished editor before removing the old copy', async () => {
  const note = { ...anchor, id: 'legacy-note', comment: 'legacy', createdAt: 1 }
  const editor = { anchor, comment: 'unfinished' }
  const key = 'orca:native-chat-annotations:v1:migration'
  localStorage.setItem(key, JSON.stringify({ version: 1, notes: [note], editor }))
  const { a } = await contexts('migration')
  expect(a.getSnapshot()).toEqual({ notes: [note], editor })
  expect(localStorage.getItem(key)).toBeNull()
  expect(
    localStorage.getItem('orca:native-chat-annotations:v2:migration:legacy-note:legacy-note')
  ).toContain('legacy')
})

it('retains the legacy copy if migration cannot save every record', async () => {
  const note = { ...anchor, id: 'legacy-note', comment: 'legacy', createdAt: 1 }
  const key = 'orca:native-chat-annotations:v1:migration-failed'
  localStorage.setItem(key, JSON.stringify({ version: 1, notes: [note] }))
  const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Full')
  })
  const { a } = await contexts('migration-failed')
  expect(a.getSnapshot().persistenceError).toBe('Full')
  expect(a.getSnapshot().notes).toEqual([note])
  expect(localStorage.getItem(key)).toContain('legacy')
  write.mockRestore()
  expect(a.retryPersistence()).toBe(true)
  expect(a.getSnapshot().notes).toEqual([note])
})
