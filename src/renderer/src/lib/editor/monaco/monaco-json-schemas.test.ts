import { describe, expect, it, vi } from 'vitest'
import { parseJsonSchemaCatalog } from './monaco-json-schemas'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: {} }) } }))
vi.mock('./json-schema-file-reader', () => ({ readJsonSchemaFile: vi.fn() }))

describe('SchemaStore catalog admission', () => {
  it('rejects malformed catalog roots', () => {
    for (const text of ['null', '{}', '{"schemas":{}}', 'invalid']) {
      expect(() => parseJsonSchemaCatalog(text)).toThrow()
    }
  })

  it('discards malformed entries and local URIs from the remote catalog', () => {
    const catalog = parseJsonSchemaCatalog(
      JSON.stringify({
        schemas: [
          null,
          {},
          { url: 42, fileMatch: ['package.json'] },
          { url: 'file:///repo/secrets.json', fileMatch: ['package.json'] },
          { url: 'https://example.com/schema', fileMatch: ['package.json', 42] },
          { url: 'https://example.com/schema', fileMatch: ['package.json'] }
        ]
      })
    )
    expect(catalog.schemas).toEqual([
      { url: 'https://example.com/schema', fileMatch: ['package.json'] }
    ])
  })
})
