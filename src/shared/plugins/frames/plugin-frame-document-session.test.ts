// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountShell } from './plugin-frame-shell-mount.test-fixture'

type Content = { kind: 'text'; text: string } | { kind: 'bytes'; bytes: ArrayBuffer }

const hello = {
  orca: 1,
  kind: 'evt',
  event: 'hello',
  payload: { theme: { colorScheme: 'dark', tokens: '' }, locale: 'en' }
}
const doc = (version: number, text: string, readOnly = false) => ({
  orca: 1,
  kind: 'evt',
  event: 'editor.document',
  payload: { version, readOnly, content: { kind: 'text', text } }
})
const accept = (id: number) => ({ orca: 1, kind: 'res', id, result: null })
const refuse = (id: number, code: string) => ({
  orca: 1,
  kind: 'res',
  id,
  error: { code, message: code }
})
const settle = () => vi.advanceTimersByTimeAsync(0)

async function open(options?: object, first = doc(1, 'a')) {
  const shell = mountShell('editor')
  fromHostAll(shell.fromHost, [hello, first])
  const session = await shell.orca.document!.session(options)
  const replaced = vi.fn()
  session.onReplace(replaced)
  const edits = () => shell.posted().filter((message) => message.method === 'editor.applyEdit')
  return { ...shell, session, replaced, edits }
}

function fromHostAll(fromHost: (data: unknown) => unknown, messages: unknown[]): void {
  messages.forEach((message) => fromHost(message))
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('orca.document.session', () => {
  it('is feature-detectable and resolves only after hello and the first document', async () => {
    const { orca, fromHost } = mountShell('editor')
    expect('session' in orca.document!).toBe(true)
    const started = vi.fn()
    void orca.document!.session().then(started)
    fromHost(doc(1, 'a'))
    await settle()
    expect(started).not.toHaveBeenCalled()
    fromHost(hello)
    await settle()
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ value: 'a', readOnly: false }))
  })

  it('coalesces changes in the debounce window into one edit', async () => {
    const { session, edits } = await open()
    session.change('b')
    session.change('bc')
    await vi.advanceTimersByTimeAsync(249)
    expect(edits()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(edits()).toEqual([
      expect.objectContaining({ params: { baseVersion: 1, content: { kind: 'text', text: 'bc' } } })
    ])
    expect(session.value).toBe('bc')
  })

  it('keeps one edit in flight and sends the newest change once it settles', async () => {
    const { session, edits, fromHost } = await open({ debounceMs: 0 })
    session.change('b')
    await settle()
    session.change('c')
    session.change('d')
    await settle()
    expect(edits()).toHaveLength(1)
    fromHost(accept(0))
    await settle()
    expect(edits().map((edit) => edit.params.content.text)).toEqual(['b', 'd'])
  })

  it('moves the baseline only on accept and keeps a refused draft', async () => {
    const { session, fromHost, edits } = await open({ debounceMs: 0 })
    session.change('b')
    const flushed = session.flush()
    fromHost(refuse(0, 'too_large'))
    await expect(flushed).rejects.toMatchObject({ code: 'too_large' })
    expect(session.value).toBe('b')
    const retried = session.flush()
    expect(edits()).toHaveLength(2)
    fromHost(accept(1))
    await expect(retried).resolves.toBeUndefined()
    await expect(session.flush()).resolves.toBeUndefined()
    expect(edits()).toHaveLength(2)
  })

  it('never reports its own accepted edits as replacements', async () => {
    const { session, fromHost, replaced, edits } = await open({ debounceMs: 0 })
    session.change('b')
    await settle()
    fromHost(accept(0))
    await settle()
    // The same text again, at a new version (a read-only flip would look like this).
    fromHost(doc(2, 'b'))
    expect(replaced).not.toHaveBeenCalled()
    fromHost(doc(3, 'outside'))
    expect(replaced).toHaveBeenCalledWith('outside')
    expect(session.value).toBe('outside')
    session.change('next')
    await settle()
    expect(edits().at(-1)).toMatchObject({ params: { baseVersion: 3 } })
  })

  it('merges a conflict once against the last accepted value and resubmits', async () => {
    const merge = vi.fn(
      (base: string, outside: string, mine: string) => `${base}|${outside}|${mine}`
    )
    const { session, fromHost, replaced, edits } = await open({ debounceMs: 0, merge })
    session.change('x')
    await settle()
    fromHost(accept(0))
    await settle()
    session.change('mine')
    fromHost(doc(2, 'outside'))
    await settle()
    expect(replaced).not.toHaveBeenCalled()
    fromHost(refuse(1, 'conflict'))
    await settle()
    expect(merge).toHaveBeenCalledTimes(1)
    expect(merge).toHaveBeenCalledWith('x', 'outside', 'mine')
    expect(replaced).toHaveBeenCalledWith('x|outside|mine')
    expect(edits().at(-1)).toMatchObject({
      params: { baseVersion: 2, content: { kind: 'text', text: 'x|outside|mine' } }
    })
  })

  it('lets the outside document win a conflict without merge', async () => {
    const { session, fromHost, replaced, edits } = await open({ debounceMs: 0 })
    session.change('mine')
    fromHost(doc(2, 'outside'))
    const flushed = session.flush()
    fromHost(refuse(0, 'conflict'))
    await expect(flushed).rejects.toMatchObject({ code: 'conflict' })
    expect(session.value).toBe('outside')
    expect(replaced).toHaveBeenCalledWith('outside')
    // The draft is gone, so nothing overwrites the outside write.
    await expect(session.flush()).resolves.toBeUndefined()
    expect(edits()).toHaveLength(1)
    session.change('next')
    await settle()
    expect(edits().at(-1)).toMatchObject({ params: { baseVersion: 2 } })
  })

  it('answers editor.flush after posting the change still in its debounce window', async () => {
    const { session, fromHost, posted } = await open()
    session.change('b')
    fromHost({ orca: 1, kind: 'req', id: 9, method: 'editor.flush' })
    await settle()
    const kinds = posted().map((message) => message.method ?? message.kind)
    expect(kinds.slice(-2)).toEqual(['editor.applyEdit', 'res'])
    expect(posted().at(-1)).toEqual({ orca: 1, kind: 'res', id: 9, result: null })
  })

  it('resends a kept draft on editor.flush, but not one still in flight', async () => {
    const { session, fromHost, edits } = await open({ debounceMs: 0 })
    session.change('b')
    await settle()
    fromHost({ orca: 1, kind: 'req', id: 8, method: 'editor.flush' })
    await settle()
    expect(edits()).toHaveLength(1)
    fromHost(refuse(0, 'too_large'))
    await settle()
    fromHost({ orca: 1, kind: 'req', id: 9, method: 'editor.flush' })
    await settle()
    expect(edits()).toHaveLength(2)
    expect(session.value).toBe('b')
  })

  it('ignores changes while read-only', async () => {
    const { session, edits } = await open({}, doc(1, 'a', true))
    expect(session.readOnly).toBe(true)
    session.change('b')
    await vi.advanceTimersByTimeAsync(500)
    expect(session.value).toBe('a')
    expect(edits()).toHaveLength(0)
  })

  it('needs decode and encode for bytes, and sends what encode returns', async () => {
    const bytesDoc = (version: number, bytes: number[]) => ({
      orca: 1,
      kind: 'evt',
      event: 'editor.document',
      payload: {
        version,
        readOnly: false,
        content: { kind: 'bytes', bytes: new Uint8Array(bytes).buffer }
      }
    })
    const shell = mountShell('editor')
    fromHostAll(shell.fromHost, [hello, bytesDoc(1, [1, 2])])
    await expect(shell.orca.document!.session()).rejects.toThrow(/decode and encode/)
    const session = await shell.orca.document!.session({
      debounceMs: 0,
      decode: (content: Content) =>
        content.kind === 'bytes' ? [...new Uint8Array(content.bytes)] : [],
      encode: (value: number[]) => ({ kind: 'bytes', bytes: new Uint8Array(value).buffer })
    })
    expect(session.value).toEqual([1, 2])
    session.change([3])
    await settle()
    const edit = shell.posted().find((message) => message.method === 'editor.applyEdit')
    expect([...new Uint8Array(edit.params.content.bytes)]).toEqual([3])
  })

  it('stops sending and reporting after dispose', async () => {
    const { session, fromHost, replaced, edits, posted } = await open({ debounceMs: 0 })
    session.change('b')
    session.dispose()
    await settle()
    session.change('c')
    fromHost(doc(2, 'outside'))
    fromHost({ orca: 1, kind: 'req', id: 4, method: 'editor.flush' })
    await settle()
    expect(edits()).toHaveLength(0)
    expect(replaced).not.toHaveBeenCalled()
    expect(posted().at(-1)).toEqual({ orca: 1, kind: 'res', id: 4, result: null })
  })
})
