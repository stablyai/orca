import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import {
  getSelectionRangeKeys,
  reconcileSelectionKeys,
  type FlatEntry
} from './useSourceControlSelection'

function makeEntry(
  key: string,
  area: FlatEntry['area'],
  path: string,
  status: GitStatusEntry['status'] = 'modified'
): FlatEntry {
  return {
    key,
    area,
    entry: {
      path,
      area,
      status
    }
  }
}

describe('reconcileSelectionKeys', () => {
  it('drops selections that no longer exist in the visible list', () => {
    const flatEntries = [
      makeEntry('unstaged::a.ts', 'unstaged', 'a.ts'),
      makeEntry('staged::b.ts', 'staged', 'b.ts')
    ]

    expect(
      reconcileSelectionKeys(new Set(['unstaged::a.ts', 'untracked::gone.ts']), flatEntries)
    ).toEqual(new Set(['unstaged::a.ts']))
  })
})

describe('getSelectionRangeKeys', () => {
  it('selects an inclusive range across visible sections', () => {
    const flatEntries = [
      makeEntry('unstaged::a.ts', 'unstaged', 'a.ts'),
      makeEntry('unstaged::b.ts', 'unstaged', 'b.ts'),
      makeEntry('staged::c.ts', 'staged', 'c.ts'),
      makeEntry('untracked::d.ts', 'untracked', 'd.ts')
    ]

    expect(getSelectionRangeKeys(flatEntries, 'unstaged::b.ts', 'untracked::d.ts')).toEqual(
      new Set(['unstaged::b.ts', 'staged::c.ts', 'untracked::d.ts'])
    )
  })

  it('returns null when the anchor is no longer visible', () => {
    const flatEntries = [
      makeEntry('staged::c.ts', 'staged', 'c.ts'),
      makeEntry('untracked::d.ts', 'untracked', 'd.ts')
    ]

    expect(getSelectionRangeKeys(flatEntries, 'unstaged::b.ts', 'untracked::d.ts')).toBeNull()
  })
})
