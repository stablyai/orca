import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import {
  buildSubmoduleChildNodes,
  injectExpandedSubmoduleEntries,
  type SubmoduleSectionTreeNode
} from './submodule-expansion'

const LOADING = 'Loading submodule changes…'
const EMPTY = 'No changes in submodule'

function submoduleEntry(partial: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    status: 'modified',
    area: 'unstaged',
    submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false },
    ...partial
  }
}

function fileNode(entry: GitStatusEntry, depth = 0): SubmoduleSectionTreeNode & { type: 'file' } {
  return {
    type: 'file',
    key: `unstaged::${entry.path}`,
    name: entry.path.split('/').pop() ?? entry.path,
    path: entry.path,
    entry,
    area: 'unstaged',
    depth
  }
}

describe('buildSubmoduleChildNodes', () => {
  it('prefixes inner paths, stamps submoduleRoot, and nests one level deeper', () => {
    const parent = fileNode(submoduleEntry({ path: 'flutter_mine' }), 2)
    const inner: GitStatusEntry[] = [
      {
        path: 'lib/main.dart',
        oldPath: 'lib/old-main.dart',
        status: 'renamed',
        area: 'unstaged'
      }
    ]

    const [child] = buildSubmoduleChildNodes(parent, inner)

    expect(child.path).toBe('flutter_mine/lib/main.dart')
    expect(child.entry.oldPath).toBe('flutter_mine/lib/old-main.dart')
    expect(child.name).toBe('main.dart')
    expect(child.entry.submoduleRoot).toBe('flutter_mine')
    expect(child.entry.status).toBe('renamed')
    expect(child.depth).toBe(3)
    expect(child.area).toBe('unstaged')
  })
})

describe('getSubmoduleExpansionKey', () => {
  it('keeps staged children in the staged area for diff routing', () => {
    const entry = submoduleEntry({
      path: 'flutter_mine',
      area: 'staged',
      submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
    })
    const result = injectExpandedSubmoduleEntries(
      [entry],
      new Set(['staged::flutter_mine']),
      {
        'staged::flutter_mine': {
          status: 'loaded',
          entries: [{ path: 'lib/main.dart', status: 'modified', area: 'unstaged' }]
        }
      },
      LOADING,
      EMPTY
    )

    expect(result[1]).toMatchObject({
      type: 'entry',
      entry: {
        path: 'flutter_mine/lib/main.dart',
        area: 'staged',
        submoduleRoot: 'flutter_mine'
      }
    })
  })
})
