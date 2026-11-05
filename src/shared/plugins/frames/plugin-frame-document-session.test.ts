// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mountShell,
  type FrameDocumentSessionOptions,
  type FrameHostMessage
} from './plugin-frame-shell-mount.test-fixture'

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

async function open(options?: FrameDocumentSessionOptions, first: FrameHostMessage = doc(1, 'a')) {
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
  it('answers editor.flush only once the change it posted is accepted', async () => {
    const { session, fromHost, posted } = await open()
    session.change('b')
    const flushRequest = { orca: 1, kind: 'req', id: 9, method: 'editor.flush' }
    fromHost(flushRequest)
    await settle()
    expect(posted().at(-1)).toMatchObject({ method: 'editor.applyEdit' })
    fromHost(accept(0))
    await settle()
    expect(posted().at(-1)).toEqual({ orca: 1, kind: 'res', id: 9, result: null })
  })

  it('keeps one edit in flight through a save, so the baseline never goes back', async () => {
    const { orca, session, fromHost, edits, posted } = await open({ debounceMs: 0 })
    session.change('a1')
    await settle()
    // `a1` is held by Orca's rate limit; the save must not post `b` beside it.
    session.change('b')
    fromHost({ orca: 1, kind: 'req', id: 9, method: 'editor.flush' })
    await settle()
    expect(edits()).toHaveLength(1)
    fromHost(accept(0))
    await settle()
    expect(edits().at(-1)).toMatchObject({ params: { content: { text: 'b' } } })
    fromHost(accept(1))
    await settle()
    expect(posted().at(-1)).toMatchObject({ kind: 'res', id: 9, result: null })
    await expect(orca.document!.get()).resolves.toMatchObject({ content: { text: 'b' } })
  })

  it('answers a save only after a conflict merge commits', async () => {
    const merge = (_base: string, outside: string, mine: string) => `${outside}+${mine}`
    const { session, fromHost, edits, posted } = await open({ debounceMs: 0, merge })
    session.change('mine')
    await settle()
    fromHost(doc(2, 'outside'))
    fromHost({ orca: 1, kind: 'req', id: 9, method: 'editor.flush' })
    fromHost(refuse(0, 'conflict'))
    await settle()
    expect(edits().at(-1)).toMatchObject({ params: { content: { text: 'outside+mine' } } })
    expect(posted().some((message) => message.kind === 'res' && message.id === 9)).toBe(false)
    fromHost(accept(1))
    await settle()
    expect(posted().at(-1)).toMatchObject({ kind: 'res', id: 9, result: null })
  })

  it('moves nothing when a disk merge throws, so the next edit cannot acknowledge it', async () => {
    const merge = vi.fn(() => {
      throw new Error('cannot merge')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { session, fromHost, edits, replaced } = await open({ debounceMs: 0, merge })
      fromHost({
        ...doc(2, 'a+agent'),
        payload: {
          version: 2,
          readOnly: false,
          content: { kind: 'text', text: 'a+agent' },
          ancestor: { kind: 'text', text: 'a' }
        }
      })
      await settle()
      expect(replaced).not.toHaveBeenCalled()
      expect(session.value).toBe('a')
      session.change('a+typed')
      await settle()
      // Still against the document before the merge: Orca refuses it and keeps its banner.
      expect(edits().at(-1)).toMatchObject({ params: { baseVersion: 1 } })
    } finally {
      error.mockRestore()
    }
  })
})
