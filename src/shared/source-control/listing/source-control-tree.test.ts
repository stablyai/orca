import { describe, expect, it } from 'vitest'

import type { GitStatusEntry } from '../../git/status/git-status-types'
import {
  buildGitStatusSourceControlTree,
  buildSourceControlTree,
  applyGitStatusEntryAreasToSourceControlTree,
  collectSourceControlTreeFileEntries,
  compactSourceControlTree,
  flattenSourceControlTree,
  namespaceSourceControlTreeDirectoryKeys
} from './source-control-tree'

function entry(partial: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    status: 'modified',
    area: 'unstaged',
    ...partial
  }
}

describe('buildSourceControlTree', () => {
  it('collects all descendant file entries for directory actions', () => {
    const tree = buildSourceControlTree('unstaged', [
      entry({ path: 'src/app.ts' }),
      entry({ path: 'src/components/Button.tsx' }),
      entry({ path: 'docs/readme.md' })
    ])

    const src = tree.find((node) => node.type === 'directory' && node.path === 'src')

    expect(src ? collectSourceControlTreeFileEntries(src).map((item) => item.path) : []).toEqual([
      'src/components/Button.tsx',
      'src/app.ts'
    ])
  })

  it('can preserve file node areas from mixed conflict section entries', () => {
    const tree = compactSourceControlTree(
      buildGitStatusSourceControlTree('unstaged', [
        entry({
          area: 'staged',
          path: 'src/resolved.ts',
          conflictKind: 'both_modified',
          conflictStatus: 'resolved_locally'
        })
      ])
    )

    const rows = flattenSourceControlTree(
      applyGitStatusEntryAreasToSourceControlTree(
        namespaceSourceControlTreeDirectoryKeys(tree, 'conflicts')
      ),
      new Set()
    )
    const directory = rows.find((node) => node.type === 'directory')
    const file = rows.find((node) => node.type === 'file')

    expect(directory?.key).toBe('dir::conflicts::src')
    expect(directory?.area).toBe('unstaged')
    expect(file?.key).toBe('staged::src/resolved.ts')
    expect(file?.area).toBe('staged')
  })
})
