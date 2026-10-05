// src/renderer/src/lib/lsp/lsp-location-models.test.ts
import { describe, expect, it, vi } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import {
  LSP_PEEK_SCHEME,
  MAX_LOCATION_FILES,
  resolveLocationModels,
  type LocationModelMonaco
} from './lsp-location-models'

type FakeModel = {
  isAttachedToEditor: () => boolean
  dispose: () => void
  isDisposed?: () => boolean
  getValue: () => string
  setValue: (value: string) => void
}

function fakeMonaco(existing: string[] = []): LocationModelMonaco<URI> & {
  created: string[]
  disposedUris: string[]
  models: Map<string, FakeModel>
} {
  const created: string[] = []
  const disposedUris: string[] = []
  const models = new Map<string, FakeModel>()
  for (const uri of existing) {
    models.set(uri, {
      isAttachedToEditor: () => true,
      dispose: vi.fn(),
      getValue: () => '',
      setValue: vi.fn()
    })
  }
  return {
    created,
    disposedUris,
    models,
    Uri: URI,
    editor: {
      getModel: (uri) => models.get(uri.toString()) ?? null,
      createModel: (initial, _language, uri) => {
        created.push(uri.toString())
        let disposed = false
        let value = initial
        const model = {
          isAttachedToEditor: () => false,
          dispose: () => {
            disposed = true
            disposedUris.push(uri.toString())
            models.delete(uri.toString())
          },
          isDisposed: () => disposed,
          getValue: () => value,
          setValue: vi.fn((next: string) => {
            value = next
          })
        }
        models.set(uri.toString(), model)
        return model
      }
    }
  }
}
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }

describe('resolveLocationModels', () => {
  it('reuses an open file model even when the server spells the URI differently', async () => {
    // Why forward slashes: URI.file only rewrites backslashes on Windows hosts, and tests run everywhere.
    const monaco = fakeMonaco([URI.file('C:/src/a.ts').toString()])
    const readFile = vi.fn()
    const result = await resolveLocationModels(
      monaco,
      [{ uri: 'file:///C:/src/a.ts', range }],
      readFile
    )
    expect(result[0].uri.toString()).toBe(URI.file('C:/src/a.ts').toString())
    expect(readFile).not.toHaveBeenCalled()
  })

  it('creates peek models for unopened files and drops unreadable ones', async () => {
    const monaco = fakeMonaco()
    const readFile = vi.fn(async (path: string) =>
      path.endsWith('bin.dat') ? { content: '', isBinary: true } : { content: 'x', isBinary: false }
    )
    const result = await resolveLocationModels(
      monaco,
      [
        { uri: 'file:///repo/b.rb', range },
        { uri: 'file:///repo/bin.dat', range }
      ],
      readFile
    )
    expect(result).toHaveLength(1)
    expect(result[0].uri.scheme).toBe(LSP_PEEK_SCHEME)
  })

  it('reads at most MAX_LOCATION_FILES distinct files', async () => {
    const monaco = fakeMonaco()
    const readFile = vi.fn(async () => ({ content: 'x', isBinary: false }))
    const locations = Array.from({ length: MAX_LOCATION_FILES + 50 }, (_, i) => ({
      uri: `file:///repo/f${i}.rb`,
      range
    }))
    const result = await resolveLocationModels(monaco, locations, readFile)
    expect(readFile).toHaveBeenCalledTimes(MAX_LOCATION_FILES)
    expect(result).toHaveLength(MAX_LOCATION_FILES)
  })

  it('keeps every model of the current result alive, then prunes to the cap on the next resolve', async () => {
    const monaco = fakeMonaco()
    const readFile = vi.fn(async () => ({ content: 'x', isBinary: false }))
    const locations = Array.from({ length: 80 }, (_, i) => ({
      uri: `file:///pool/f${i}.rb`,
      range
    }))
    const first = await resolveLocationModels(monaco, locations, readFile)
    expect(first).toHaveLength(80)
    expect(monaco.disposedUris).toEqual([])

    const other = [{ uri: 'file:///other/x.rb', range }]
    await resolveLocationModels(monaco, other, readFile)
    expect(monaco.disposedUris).toHaveLength(31)
  })

  it('refreshes a reused detached peek model from disk, and drops it once unreadable', async () => {
    const monaco = fakeMonaco()
    let disk: { content: string; isBinary: boolean } | null = { content: 'v1', isBinary: false }
    const readFile = vi.fn(async () => {
      if (!disk) {
        throw new Error('gone')
      }
      return disk
    })
    const locations = [{ uri: 'file:///refresh/a.rb', range }]
    const [first] = await resolveLocationModels(monaco, locations, readFile)
    disk = { content: 'v2', isBinary: false }
    const [second] = await resolveLocationModels(monaco, locations, readFile)
    expect(second.uri.toString()).toBe(first.uri.toString())
    expect(monaco.created).toHaveLength(1)
    expect(monaco.models.get(first.uri.toString())?.getValue()).toBe('v2')

    disk = null
    expect(await resolveLocationModels(monaco, locations, readFile)).toEqual([])
    expect(monaco.disposedUris).toContain(first.uri.toString())
  })

  it('starts every file read before awaiting any of them', async () => {
    const monaco = fakeMonaco()
    const resolvers: (() => void)[] = []
    const readFile = vi.fn(
      () =>
        new Promise<{ content: string; isBinary: boolean }>((resolve) => {
          resolvers.push(() => resolve({ content: 'x', isBinary: false }))
        })
    )
    const result = resolveLocationModels(
      monaco,
      [
        { uri: 'file:///concurrent/a.rb', range },
        { uri: 'file:///concurrent/b.rb', range }
      ],
      readFile
    )
    await Promise.resolve()
    expect(readFile).toHaveBeenCalledTimes(2)
    resolvers.forEach((resolve) => resolve())
    expect(await result).toHaveLength(2)
  })
})
