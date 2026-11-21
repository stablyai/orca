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
})
