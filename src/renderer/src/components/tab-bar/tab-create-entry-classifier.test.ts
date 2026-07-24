import { describe, expect, it } from 'vitest'
import { QUICK_OPEN_QUERY_MAX_BYTES } from '../quick-open-search'
import {
  classifyTabEntryQuery,
  getTabEntryOptions,
  TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE,
  validateNewTabEntryAbsolutePath,
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

  it('opens local-dev URLs with root suffixes as browser tabs', () => {
    expect(classifyTabEntryQuery('localhost:3000/', readyFiles([]))).toEqual({
      kind: 'host-url',
      url: 'http://localhost:3000/'
    })
    expect(classifyTabEntryQuery('localhost:3000?debug=1', readyFiles([]))).toEqual({
      kind: 'host-url',
      url: 'http://localhost:3000/?debug=1'
    })
    expect(classifyTabEntryQuery('localhost:3000#preview', readyFiles([]))).toEqual({
      kind: 'host-url',
      url: 'http://localhost:3000/#preview'
    })
  })

  it('keeps the shared legacy local-dev forms in parity with address-bar normalization', () => {
    for (const input of ['0.0.0.0:3000', '[::1]:3000', '[2001:db8::1]:3000/path']) {
      expect(classifyTabEntryQuery(input, readyFiles([]))).toMatchObject({
        kind: 'host-url',
        url: expect.stringMatching(/^http:/)
      })
    }
  })

  it('does not classify invalid numeric hosts as URLs', () => {
    expect(classifyTabEntryQuery('999.999.999.999', readyFiles([]))).toEqual({
      kind: 'new-file',
      relativePath: '999.999.999.999'
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

  it('blocks oversized pasted file-entry queries before reading listed files', () => {
    const oversizedQuery = `src/${'secret-tab-create'.repeat(QUICK_OPEN_QUERY_MAX_BYTES)}.ts`
    const fileList = {
      get files(): string[] {
        throw new Error('oversized queries must not read file lists')
      },
      loading: false,
      loadError: null
    }

    expect(classifyTabEntryQuery(oversizedQuery, fileList)).toEqual({
      kind: 'blocked',
      message: 'Search text is too large.'
    })
  })

  it('blocks oversized whitespace before trimming file-entry queries', () => {
    const fileList = {
      get files(): string[] {
        throw new Error('oversized whitespace queries must not read file lists')
      },
      loading: false,
      loadError: null
    }

    expect(classifyTabEntryQuery(' '.repeat(QUICK_OPEN_QUERY_MAX_BYTES + 1), fileList)).toEqual({
      kind: 'blocked',
      message: 'Search text is too large.'
    })
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

  it('classifies POSIX absolute paths only for POSIX clients', () => {
    expect(
      classifyTabEntryQuery('/tmp/notes.md', readyFiles([]), {
        allowAbsolutePaths: true,
        localPlatform: 'posix'
      })
    ).toEqual({ kind: 'absolute-file', filePath: '/tmp/notes.md' })
    expect(
      classifyTabEntryQuery('C:\\tmp\\notes.md', readyFiles([]), {
        allowAbsolutePaths: true,
        localPlatform: 'posix'
      })
    ).toMatchObject({ kind: 'blocked', message: 'Enter an absolute path for this computer.' })
  })

  it('classifies drive and UNC paths only for Windows clients', () => {
    for (const [query, filePath] of [
      ['C:\\tmp\\notes.md', 'C:/tmp/notes.md'],
      ['C:/tmp/notes.md', 'C:/tmp/notes.md'],
      ['\\\\server\\share\\notes.md', '//server/share/notes.md'],
      ['//server/share/notes.md', '//server/share/notes.md']
    ]) {
      expect(
        classifyTabEntryQuery(query, readyFiles([]), {
          allowAbsolutePaths: true,
          localPlatform: 'windows'
        })
      ).toEqual({
        kind: 'absolute-file',
        filePath
      })
    }
    expect(
      classifyTabEntryQuery('/tmp/notes.md', readyFiles([]), {
        allowAbsolutePaths: true,
        localPlatform: 'windows'
      })
    ).toMatchObject({ kind: 'blocked', message: 'Enter an absolute path for this computer.' })
  })

  it('blocks absolute paths for remote workspaces', () => {
    for (const query of [
      '/tmp/notes.md',
      'C:\\tmp\\notes.md',
      'C:/tmp/notes.md',
      '\\\\server\\share\\notes.md',
      '//server/share/notes.md'
    ]) {
      expect(classifyTabEntryQuery(query, readyFiles([]))).toMatchObject({
        kind: 'blocked',
        message: TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE
      })
    }
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

  it('normalizes absolute paths for local open', () => {
    expect(validateNewTabEntryAbsolutePath('/tmp/notes.md', 'posix')).toBe('/tmp/notes.md')
    expect(validateNewTabEntryAbsolutePath('C:\\tmp\\notes.md', 'windows')).toBe('C:/tmp/notes.md')
    expect(validateNewTabEntryAbsolutePath('\\\\server\\share\\notes.md', 'windows')).toBe(
      '//server/share/notes.md'
    )
    expect(validateNewTabEntryAbsolutePath('/repo/../repo/src/file.ts', 'posix')).toBe(
      '/repo/src/file.ts'
    )
  })

  it('rejects path families that are not native to the client', () => {
    expect(() => validateNewTabEntryAbsolutePath('C:\\tmp\\notes.md', 'posix')).toThrow(
      'this computer'
    )
    expect(() => validateNewTabEntryAbsolutePath('\\\\server\\share\\notes.md', 'posix')).toThrow(
      'this computer'
    )
    expect(() => validateNewTabEntryAbsolutePath('/tmp/notes.md', 'windows')).toThrow(
      'this computer'
    )
  })

  it('rejects invalid absolute paths', () => {
    for (const path of ['', '~/file.ts', 'src/file.ts', 'C:tmp/file.ts', '/tmp/']) {
      expect(() => validateNewTabEntryAbsolutePath(path), path).toThrow()
    }
  })
})
