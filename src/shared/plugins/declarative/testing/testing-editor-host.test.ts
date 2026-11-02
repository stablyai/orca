import { afterEach, describe, expect, it } from 'vitest'
import { mockEditorHost, type MockEditorHost } from './testing-editor-host'

type Session = {
  value: unknown
  readOnly: boolean
  change: (next: unknown) => void
  flush: () => Promise<void>
  onReplace: (fn: (value: unknown) => void) => { dispose: () => void }
  dispose: () => void
}

function isSession(value: unknown): value is Session {
  return typeof value === 'object' && value !== null && 'change' in value && 'flush' in value
}

/** `globalThis.orca.document.session(options)`, as an editor would call it. */
async function session(options: object = {}): Promise<Session> {
  const orca: unknown = Reflect.get(globalThis, 'orca')
  const document: unknown = typeof orca === 'object' && orca ? Reflect.get(orca, 'document') : null
  const open: unknown = document ? Reflect.get(document, 'session') : null
  if (typeof open !== 'function') {
    throw new Error('no orca.document.session')
  }
  const opened: unknown = await Reflect.apply(open, document, [{ debounceMs: 0, ...options }])
  if (!isSession(opened)) {
    throw new Error('not a session')
  }
  return opened
}

let host: MockEditorHost | null = null
afterEach(() => {
  host?.dispose()
  host = null
})

describe('mockEditorHost', () => {
  it('installs orca with the real document session over an in-memory file', async () => {
    host = mockEditorHost({ text: 'a' })
    const doc = await session()
    expect(doc.value).toBe('a')
    doc.change('ab')
    await host.flush()
    expect(host.text).toBe('ab')
    expect(host.edits).toEqual([{ baseVersion: 1, content: { kind: 'text', text: 'ab' } }])
    doc.dispose()
  })

  it('sends outside changes and refuses the next edit on conflictNext', async () => {
    host = mockEditorHost({ text: 'a' })
    const replaced: unknown[] = []
    const doc = await session({
      merge: (_base: string, outside: string, mine: string) => outside + mine
    })
    doc.onReplace((value) => replaced.push(value))
    host.replace('outside')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replaced).toEqual(['outside'])
    host.conflictNext('agent')
    doc.change('outside!')
    await doc.flush()
    expect(host.edits.map((edit) => edit.refused ?? 'applied')).toEqual(['conflict', 'applied'])
    expect(host.text).toBe('agentoutside!')
    expect(replaced.at(-1)).toBe('agentoutside!')
    doc.dispose()
  })

  it('backs a bytes editor, follows the theme, and removes orca on dispose', async () => {
    host = mockEditorHost({ bytes: new Uint8Array([1]) }, { fileType: 'bin', colorScheme: 'light' })
    const doc = await session({
      decode: (content: { bytes: ArrayBuffer }) => [...new Uint8Array(content.bytes)],
      encode: (value: number[]) => ({ kind: 'bytes', bytes: new Uint8Array(value).buffer })
    })
    expect(doc.value).toEqual([1])
    doc.change([2, 3])
    await host.flush()
    expect([...(host.bytes ?? [])]).toEqual([2, 3])
    const themes: unknown[] = []
    const orca: unknown = Reflect.get(globalThis, 'orca')
    Reflect.apply(Reflect.get(Object(orca), 'on'), orca, ['theme', (t: unknown) => themes.push(t)])
    host.setTheme('dark')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(themes).toEqual([{ colorScheme: 'dark' }])
    doc.dispose()
    host.dispose()
    expect(Reflect.get(globalThis, 'orca')).toBeUndefined()
  })
})
