import { describe, expect, it } from 'vitest'
import { withFolderPaths } from './quick-open-folder-paths'
import { getPreparedQuickOpenFiles, rankQuickOpenFiles } from './quick-open-path-search'

const LISTING = [
  'README.md',
  'src/index.ts',
  'src/components/Button.tsx',
  'src/components/forms/Input.tsx',
  'web/forms.ts'
]

const rank = (query: string) =>
  rankQuickOpenFiles(query, getPreparedQuickOpenFiles(withFolderPaths(LISTING))).map(
    (result) => result.path
  )

describe('withFolderPaths', () => {
  it('ranks a folder whose name matches first, then ties by name', () => {
    expect(rank('comp')).toEqual([
      'src/components/',
      'src/components/Button.tsx',
      'src/components/forms/',
      'src/components/forms/Input.tsx'
    ])
  })

  it('scores a folder by its own name, as a file is', () => {
    expect(rank('forms')).toEqual([
      'src/components/forms/',
      'web/forms.ts',
      'src/components/forms/Input.tsx'
    ])
  })

  const foldersOf = (files: string[]) => withFolderPaths(files).slice(files.length)

  it('keeps the 256 shallowest folders of a sparse listing, in listing order', () => {
    // 400 folders: a0/ … a199/ and a0/b/ … a199/b/.
    const folders = foldersOf(Array.from({ length: 200 }, (_, i) => `a${i}/b/f.ts`))
    expect(folders).toHaveLength(256)
    expect(folders).toContain('a199/')
    expect(folders).toContain('a55/b/')
    expect(folders).not.toContain('a56/b/')
  })

  it('stops at the shallowest depth that fills the limit without walking deeper', () => {
    // 6,000 folders, past the full walk's ceiling: only the first 256 top-level ones stay.
    const folders = foldersOf(Array.from({ length: 2000 }, (_, i) => `p${i}/q/r/f.ts`))
    expect(folders).toHaveLength(256)
    expect(folders[0]).toBe('p0/')
    expect(folders).toContain('p255/')
    expect(folders).not.toContain('p256/')
    expect(folders).not.toContain('p0/q/')
  })
})
