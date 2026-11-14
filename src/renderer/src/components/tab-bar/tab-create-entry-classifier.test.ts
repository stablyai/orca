import { describe, expect, it } from 'vitest'
import { classifyTabEntryQuery, getTabEntryOptions } from './tab-create-entry-classifier'

const readyFiles = (files: string[]) => ({ files, loading: false, loadError: null })

describe('tab create entry classification', () => {
  it('never turns invalid paths into search actions', () => {
    for (const query of ['../.env', 'foo//bar', 'foo/', 'C:relative.txt', 'src/\u0000file.ts']) {
      expect(classifyTabEntryQuery(query, readyFiles([])), query).toMatchObject({ kind: 'blocked' })
      expect(
        classifyTabEntryQuery(query, { files: [], loading: true, loadError: null }),
        query
      ).toMatchObject({ kind: 'blocked' })
    }
  })

  it('offers both exact file and URL actions for host-like filenames', () => {
    expect(
      getTabEntryOptions('example.com', readyFiles(['example.com'])).map(
        (option) => option.classification
      )
    ).toEqual([
      { kind: 'existing-file', matchKind: 'exact-path', relativePath: 'example.com' },
      { kind: 'host-url', url: 'https://example.com/' }
    ])
  })
})
