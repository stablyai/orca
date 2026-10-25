// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const anchor = { messageId: 'reply', quote: 'Original text', startOffset: 0 }
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

async function contexts(scope: string) {
  vi.resetModules()
  const a = (await import('./native-chat-annotations-store')).getNativeChatAnnotationsStore(scope)
  vi.resetModules()
  const b = (await import('./native-chat-annotations-store')).getNativeChatAnnotationsStore(scope)
  return { a, b }
}

async function reload(scope: string) {
  vi.resetModules()
  return (await import('./native-chat-annotations-store')).getNativeChatAnnotationsStore(scope)
}

it('retries failed consumption of the exact old revision without removing a newer comment', async () => {
  const scope = 'consume-retry'
  const { a, b } = await contexts(scope)
  const note = a.add(anchor, 'Old text copied to composer')
  if (!note) {
    throw new Error('Missing note')
  }
  const transferred = a.getSnapshot().notes
  const write = localStorage.setItem.bind(localStorage)
  const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.includes(':consumed-note:')) {
      throw new Error('Temporary cleanup failure')
    }
    write(key, value)
  })
  expect(a.consume(transferred)).toBe(false)
  blocked.mockRestore()
  expect((await reload(scope)).getSnapshot().notes).toEqual(transferred)
  expect(b.update(note.id, 'New text never copied to composer')).toBe(true)
  expect(a.retryPersistence()).toBe(true)
  expect((await reload(scope)).getSnapshot().notes.map((entry) => entry.comment)).toEqual([
    'New text never copied to composer'
  ])
})

it.each(['before', 'after'] as const)(
  'preserves a cross-window edit %s the consumption marker is written',
  async (when) => {
    const scope = `consume-interleaved-${when}`
    const { a, b } = await contexts(scope)
    const note = a.add(anchor, 'Old transferred text')
    if (!note) {
      throw new Error('Missing note')
    }
    const transferred = a.getSnapshot().notes
    const write = localStorage.setItem.bind(localStorage)
    let interleaved = false
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      const intercept =
        !interleaved &&
        (when === 'before' ? key.includes(':consumed-note:') : key.endsWith(`:note:${note.id}`))
      if (intercept) {
        interleaved = true
      }
      if (intercept && when === 'before') {
        expect(b.update(note.id, 'New concurrent comment')).toBe(true)
      }
      if (intercept && when === 'after') {
        expect(a.consume(transferred)).toBe(true)
      }
      write(key, value)
    })
    if (when === 'before') {
      expect(a.consume(transferred)).toBe(true)
    } else {
      expect(b.update(note.id, 'New concurrent comment')).toBe(true)
    }
    expect(interleaved).toBe(true)
    const comments = (await reload(scope)).getSnapshot().notes.map((entry) => entry.comment)
    expect(comments).toEqual(['New concurrent comment'])
  }
)

it('does not hide a new revision whose text happens to match an older transferred version', async () => {
  const scope = 'consume-same-text'
  const { a, b } = await contexts(scope)
  const note = a.add(anchor, 'Repeated comment')
  if (!note) {
    throw new Error('Missing note')
  }
  const transferred = a.getSnapshot().notes
  expect(b.update(note.id, 'Repeated comment')).toBe(true)
  const revised = b.getSnapshot().notes[0]
  expect(revised.revision).not.toBe(note.revision)
  expect(a.consume(transferred)).toBe(true)
  expect((await reload(scope)).getSnapshot().notes).toEqual([revised])
})

it('retries a failed editor consumption without clearing an updated editor draft', async () => {
  const scope = 'consume-editor-retry'
  const { a, b } = await contexts(scope)
  a.setEditor({ anchor, comment: 'Old editor already transferred' })
  const transferred = a.getSnapshot().editor
  const write = localStorage.setItem.bind(localStorage)
  const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.includes(':consumed-editor:')) {
      throw new Error('Temporary cleanup failure')
    }
    write(key, value)
  })
  expect(a.consume([], transferred)).toBe(false)
  blocked.mockRestore()
  b.setEditor({ anchor, comment: 'New editor never transferred' })
  const current = b.getSnapshot().editor
  expect(a.retryPersistence()).toBe(true)
  expect((await reload(scope)).getSnapshot().editor).toEqual(current)
})

it('preserves an editor changed immediately before the old editor is marked consumed', async () => {
  const scope = 'consume-editor-interleaved'
  const { a, b } = await contexts(scope)
  a.setEditor({ anchor, comment: 'Old editor' })
  const transferred = a.getSnapshot().editor
  const write = localStorage.setItem.bind(localStorage)
  let interleaved = false
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (!interleaved && key.includes(':consumed-editor:')) {
      interleaved = true
      b.setEditor({ anchor, comment: 'New editor' })
    }
    write(key, value)
  })
  expect(a.consume([], transferred)).toBe(true)
  expect(interleaved).toBe(true)
  expect((await reload(scope)).getSnapshot().editor?.comment).toBe('New editor')
})

it('keeps a newer editor revision even when its text matches the transferred editor', async () => {
  const scope = 'consume-same-editor-text'
  const { a, b } = await contexts(scope)
  a.setEditor({ anchor, comment: 'Repeated editor comment' })
  const transferred = a.getSnapshot().editor
  b.setEditor({ anchor, comment: 'Repeated editor comment' })
  const current = b.getSnapshot().editor
  expect(current?.revision).not.toBe(transferred?.revision)
  expect(a.consume([], transferred)).toBe(true)
  expect((await reload(scope)).getSnapshot().editor).toEqual(current)
})

it('does not retry a failed editor cancellation against another window newer draft', async () => {
  const scope = 'editor-cancel-retry'
  const { a, b } = await contexts(scope)
  a.setEditor({ anchor, comment: 'Canceled editor' })
  const write = localStorage.setItem.bind(localStorage)
  const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.includes(':consumed-editor:')) {
      throw new Error('Temporary cleanup failure')
    }
    write(key, value)
  })
  a.setEditor(undefined)
  expect(a.getSnapshot().persistenceError).toBe('Temporary cleanup failure')
  blocked.mockRestore()
  b.setEditor({ anchor, comment: 'New draft after cancellation' })
  expect(a.retryPersistence()).toBe(true)
  expect((await reload(scope)).getSnapshot().editor?.comment).toBe('New draft after cancellation')
})

it('consumes legacy unversioned notes and drafts without hiding their later revisions', async () => {
  const scope = 'consume-legacy'
  const note = { ...anchor, id: 'legacy', createdAt: 1, comment: 'Old legacy text' }
  const editor = { anchor, comment: 'Old legacy editor' }
  localStorage.setItem(`orca:native-chat-annotations:v2:${scope}:note:legacy`, JSON.stringify(note))
  localStorage.setItem(`orca:native-chat-annotations:v2:${scope}:editor`, JSON.stringify(editor))
  const { a, b } = await contexts(scope)
  b.update(note.id, 'New legacy note')
  b.setEditor({ anchor, comment: 'New legacy editor' })
  expect(a.consume([note], editor)).toBe(true)
  const restored = (await reload(scope)).getSnapshot()
  expect(restored.notes[0]?.comment).toBe('New legacy note')
  expect(restored.editor?.comment).toBe('New legacy editor')
})

it('does not replay transferred but previously unsaved edits over a newer window value', async () => {
  const scope = 'consume-unsaved-edits'
  const { a, b } = await contexts(scope)
  const note = a.add(anchor, 'Saved before edits')
  if (!note) {
    throw new Error('Missing note')
  }
  const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Full')
  })
  a.update(note.id, 'Unsaved local edit already transferred')
  a.setEditor({ anchor, comment: 'Unsaved local editor already transferred' })
  const transferred = a.getSnapshot()
  blocked.mockRestore()
  b.update(note.id, 'New other-window note')
  b.setEditor({ anchor, comment: 'New other-window editor' })
  expect(a.consume(transferred.notes, transferred.editor)).toBe(true)
  const restored = (await reload(scope)).getSnapshot()
  expect(restored.notes[0]?.comment).toBe('New other-window note')
  expect(restored.editor?.comment).toBe('New other-window editor')
})
