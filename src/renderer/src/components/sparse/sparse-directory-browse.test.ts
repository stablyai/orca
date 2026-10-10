import { describe, expect, it } from 'vitest'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import {
  getSparseBrowseTrail,
  joinSparseBrowsePath,
  listBrowsableDirectories
} from './sparse-directory-browse'

const entry = (name: string, isDirectory: boolean): DirEntry => ({
  name,
  isDirectory,
  isSymlink: false
})

describe('listBrowsableDirectories', () => {
  it('keeps only sorted, non-hidden directories', () => {
    expect(
      listBrowsableDirectories([
        entry('packages', true),
        entry('README.md', false),
        entry('.git', true),
        entry('.vscode', true),
        entry('node_modules', true),
        entry('apps', true)
      ])
    ).toEqual(['apps', 'packages'])
  })
})

describe('joinSparseBrowsePath', () => {
  it('omits the separator at the repository root', () => {
    expect(joinSparseBrowsePath('', 'apps')).toBe('apps')
    expect(joinSparseBrowsePath('apps', 'web')).toBe('apps/web')
  })
})

describe('getSparseBrowseTrail', () => {
  it('builds cumulative segments', () => {
    expect(getSparseBrowseTrail('')).toEqual([])
    expect(getSparseBrowseTrail('apps/web')).toEqual([
      { name: 'apps', path: 'apps' },
      { name: 'web', path: 'apps/web' }
    ])
  })
})
