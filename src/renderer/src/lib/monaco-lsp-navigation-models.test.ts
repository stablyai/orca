import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearLspNavigationModels,
  prepareLspNavigationModels
} from './monaco-lsp-navigation-models'

const context = {
  modelUri: 'file:///repo/Seat.kt',
  worktreePath: '/repo',
  filePath: '/repo/Seat.kt',
  worktreeId: 'remote',
  languageId: 'kotlin',
  content: '',
  connectionId: 'ssh-1',
  documentId: 'doc-1'
}
const location = {
  uri: 'file:///repo/Caller.kt',
  range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } }
}
const readFile = vi.fn(async () => ({ content: 'fun caller() {}', isBinary: false }))
const dispose = vi.fn()
const createModel = vi.fn(() => ({ dispose }))
const parse = (value: string) => {
  const url = new URL(value)
  return {
    scheme: url.protocol.slice(0, -1),
    authority: url.host,
    path: decodeURIComponent(url.pathname),
    toString: () => value,
    with: ({ query }: { query: string }) => ({ toString: () => `${value}?${query}` })
  }
}
class Range {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number
  ) {}
}
const monaco = { Uri: { parse }, Range, editor: { createModel } }
afterEach(() => {
  clearLspNavigationModels(context.modelUri)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('LSP navigation preview models', () => {
  it('reads each destination once on its SSH host and disposes owned previews', async () => {
    vi.stubGlobal('window', { api: { fs: { readFile } } })
    const result = await prepareLspNavigationModels(
      monaco as never,
      context,
      [location, location],
      () => true
    )
    expect(readFile).toHaveBeenCalledExactlyOnceWith({
      filePath: '/repo/Caller.kt',
      connectionId: 'ssh-1'
    })
    expect(createModel).toHaveBeenCalledTimes(1)
    expect(result[0].uri.toString()).toContain('orca-lsp=doc-1')
    expect(result[1].uri).toBe(result[0].uri)
    clearLspNavigationModels(context.modelUri)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('uses the current unsaved buffer for an already-open destination', async () => {
    vi.stubGlobal('window', { api: { fs: { readFile } } })
    await prepareLspNavigationModels(
      monaco as never,
      context,
      [location],
      () => true,
      () => ({ getValue: () => 'unsaved edit' }) as never
    )
    expect(readFile).not.toHaveBeenCalled()
    expect(createModel).toHaveBeenCalledWith('unsaved edit', 'kotlin', expect.anything())
  })

  it('discards a read that finishes after its source document closes', async () => {
    let finish!: (file: { content: string; isBinary: boolean }) => void
    const pending = new Promise<{ content: string; isBinary: boolean }>((resolve) => {
      finish = resolve
    })
    vi.stubGlobal('window', { api: { fs: { readFile: () => pending } } })
    const result = prepareLspNavigationModels(monaco as never, context, [location], () => true)
    clearLspNavigationModels(context.modelUri)
    finish({ content: 'late', isBinary: false })
    expect(await result).toEqual([])
    expect(createModel).not.toHaveBeenCalled()
  })

  it('keeps the original model URI for declaration-to-usages fallback', async () => {
    const result = await prepareLspNavigationModels(
      monaco as never,
      context,
      [{ ...location, uri: context.modelUri }],
      () => true
    )
    expect(result[0].uri.toString()).toBe(context.modelUri)
    expect(createModel).not.toHaveBeenCalled()
  })
})
