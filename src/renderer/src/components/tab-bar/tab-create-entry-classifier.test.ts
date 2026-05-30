import { describe, expect, it } from 'vitest'
import {
  classifyTabEntryQuery,
  getTabEntryOptions,
  validateNewTabEntryRelativePath
} from './tab-create-entry-action'

const readyFiles = (files: string[]) => ({ files, loading: false, loadError: null })

describe('tab create entry classification', () => {
  it('accepts explicit http and https URLs only', () => {
    expect(classifyTabEntryQuery(' https://example.com/docs ', readyFiles([]))).toMatchObject({
      kind: 'explicit-url',
      url: 'https://example.com/docs'
    })
    expect(classifyTabEntryQuery('http://localhost:3000', readyFiles([]))).toMatchObject({
      kind: 'explicit-url',
      url: 'http://localhost:3000/'
    })
    expect(classifyTabEntryQuery('ftp://example.com', readyFiles([]))).toMatchObject({
      kind: 'blocked'
    })
  })

  it('lets existing listed files win over bare host-like URLs', () => {
    expect(classifyTabEntryQuery('example.com', readyFiles(['example.com']))).toEqual({
      kind: 'existing-file',
      matchKind: 'exact-path',
      relativePath: 'example.com'
    })
    expect(classifyTabEntryQuery('example.com', readyFiles([]))).toMatchObject({
      kind: 'host-url',
      url: 'https://example.com/'
    })
  })

  it('keeps common source/document filenames as file candidates', () => {
    expect(classifyTabEntryQuery('README.md', readyFiles([]))).toEqual({
      kind: 'new-file',
      relativePath: 'README.md'
    })
    expect(classifyTabEntryQuery('src/foo.test.ts', readyFiles([]))).toEqual({
      kind: 'new-file',
      relativePath: 'src/foo.test.ts'
    })
    expect(classifyTabEntryQuery('docs/readme.md', readyFiles([]))).toEqual({
      kind: 'new-file',
      relativePath: 'docs/readme.md'
    })
  })

  it('blocks non-explicit URLs and file paths while list state is not ready', () => {
    expect(
      classifyTabEntryQuery('example.com', { files: [], loading: true, loadError: null })
    ).toEqual({
      kind: 'blocked',
      message: 'Loading files...'
    })
    expect(
      classifyTabEntryQuery('https://example.com', { files: [], loading: true, loadError: null })
    ).toMatchObject({ kind: 'explicit-url' })
    expect(
      classifyTabEntryQuery('example.com', {
        files: [],
        loading: false,
        loadError: 'scan failed'
      })
    ).toEqual({ kind: 'blocked', message: 'scan failed' })
  })

  it('matches exact relative path before basename and fuzzy results', () => {
    const files = readyFiles(['src/index.ts', 'docs/index.ts', 'src/components/Button.tsx'])
    expect(classifyTabEntryQuery('docs/index.ts', files)).toEqual({
      kind: 'existing-file',
      matchKind: 'exact-path',
      relativePath: 'docs/index.ts'
    })
    expect(classifyTabEntryQuery('Button.tsx', files)).toEqual({
      kind: 'existing-file',
      matchKind: 'exact-basename',
      relativePath: 'src/components/Button.tsx'
    })
    expect(classifyTabEntryQuery('btn', files)).toEqual({
      kind: 'existing-file',
      matchKind: 'fuzzy',
      relativePath: 'src/components/Button.tsx'
    })
  })

  it('returns duplicate basename matches as separate open-file options', () => {
    expect(
      getTabEntryOptions('index.ts', readyFiles(['src/index.ts', 'docs/index.ts'])).map(
        (option) => option.classification
      )
    ).toEqual([
      { kind: 'existing-file', matchKind: 'exact-basename', relativePath: 'src/index.ts' },
      { kind: 'existing-file', matchKind: 'exact-basename', relativePath: 'docs/index.ts' }
    ])
  })

  it('prefers creating typed file paths over fuzzy matches', () => {
    expect(
      getTabEntryOptions('read.md', readyFiles(['README.md'])).map(
        (option) => option.classification
      )
    ).toEqual([
      { kind: 'new-file', relativePath: 'read.md' },
      { kind: 'existing-file', matchKind: 'fuzzy', relativePath: 'README.md' }
    ])
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

describe('tab create entry path validation', () => {
  it('rejects unsafe or non-relative paths', () => {
    for (const path of [
      '',
      '/tmp/file.ts',
      'C:/tmp/file.ts',
      'C:tmp/file.ts',
      '\\\\server\\share\\file.ts',
      '~',
      '~/file.ts',
      'src/',
      'src//file.ts',
      'src/../file.ts',
      'src\\.\\file.ts',
      'src\\..\\file.ts',
      'src/\u0000file.ts'
    ]) {
      expect(() => validateNewTabEntryRelativePath(path), path).toThrow()
    }
  })

  it('allows spaces and normalizes Windows separators after absolute checks', () => {
    expect(validateNewTabEntryRelativePath(' docs/My Note.md ')).toBe('docs/My Note.md')
    expect(validateNewTabEntryRelativePath('src\\new-file.ts')).toBe('src/new-file.ts')
  })
})
