import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import {
  reconcileSourceControlSelectionState,
  type FlatEntry
} from './source-control/listing/use-selection'

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

describe('reconcileSourceControlSelectionState', () => {
  it('returns the same references without scanning rows when nothing is selected', () => {
    const selectedKeys: ReadonlySet<string> = new Set()
    let keyReads = 0
    const flatEntries = Array.from({ length: 50 }, (_, index) => ({
      get key() {
        keyReads += 1
        return `file-${index}.ts`
      }
    })) as unknown as Parameters<typeof reconcileSourceControlSelectionState>[0]['flatEntries']

    const result = reconcileSourceControlSelectionState({
      selectedKeys,
      anchorKey: null,
      flatEntries
    })

    expect(keyReads).toBe(0)
    expect(result.selectedKeys).toBe(selectedKeys)
    expect(result.anchorKey).toBeNull()
  })

  it('prunes stale selected keys and clears stale range anchors', () => {
    const flatEntries = [makeEntry('staged::b.ts', 'staged', 'b.ts')]

    expect(
      reconcileSourceControlSelectionState({
        selectedKeys: new Set(['unstaged::a.ts', 'staged::b.ts']),
        anchorKey: 'unstaged::a.ts',
        flatEntries
      })
    ).toEqual({
      selectedKeys: new Set(['staged::b.ts']),
      anchorKey: null
    })
  })
})
