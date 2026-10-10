import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { getDiscardAllPaths, getUnstageAllPaths } from './discard-all-sequence'

const rename: GitStatusEntry = {
  path: 'new/file.txt',
  oldPath: 'old/file.txt',
  status: 'renamed',
  area: 'staged'
}

describe('rename mutation selection', () => {
  it('includes the old deletion for selection, directory and section unstaging', () => {
    expect(getUnstageAllPaths([rename])).toEqual(['new/file.txt', 'old/file.txt'])
  })

  it('unstages and restores both paths when discarding staged renames', () => {
    expect(getDiscardAllPaths([rename], 'staged')).toEqual(['new/file.txt', 'old/file.txt'])
  })

  it('leaves a copy source outside the selected mutation', () => {
    const copy = { ...rename, status: 'copied' as const }
    expect(getUnstageAllPaths([copy])).toEqual(['new/file.txt'])
    expect(getDiscardAllPaths([copy], 'staged')).toEqual(['new/file.txt'])
  })

  it('does not reset submodule-internal entries in the parent index', () => {
    expect(getUnstageAllPaths([{ ...rename, submoduleRoot: 'new' }])).toEqual([])
  })

  it('does not add a stale old path to an unstaged discard', () => {
    expect(getDiscardAllPaths([{ ...rename, area: 'unstaged' }], 'unstaged')).toEqual([
      'new/file.txt'
    ])
  })
})
