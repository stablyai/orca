import { describe, expect, it } from 'vitest'
import {
  getNameFilterCollapsedPathsAfterExpand,
  getNextNameFilterCollapsedPaths
} from './file-explorer-name-filter-projection'

describe('getNextNameFilterCollapsedPaths', () => {
  it('collapses expanded filtered folders and expands collapsed filtered folders', () => {
    const collapsed = getNextNameFilterCollapsedPaths(new Set(), '/repo/src', true)
    expect([...collapsed]).toEqual(['/repo/src'])

    const expanded = getNextNameFilterCollapsedPaths(collapsed, '/repo/src', false)
    expect([...expanded]).toEqual([])
  })

  it('expands filtered folders without toggling unrelated collapsed paths', () => {
    const expanded = getNameFilterCollapsedPathsAfterExpand(
      new Set(['/repo/docs', '/repo/src']),
      '/repo/src'
    )

    expect([...expanded]).toEqual(['/repo/docs'])
  })
})
