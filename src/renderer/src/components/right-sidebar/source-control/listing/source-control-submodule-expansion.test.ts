import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import {
  buildSubmoduleChildNodes,
  collectListSelectionEntries,
  getSubmoduleExpansionKey,
  injectExpandedSubmoduleEntries,
  injectExpandedSubmoduleRows,
  isExpandableSubmoduleEntry,
  type SubmoduleSectionTreeNode,
  type SubmoduleStatusState
} from './submodule-expansion'
import { getSourceControlDirectoryActionPaths } from './directory-action-paths'

const LOADING = 'Loading submodule changes…'
const EMPTY = 'No changes in submodule'
const FLUTTER_KEY = 'unstaged::flutter_mine'

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

describe('isExpandableSubmoduleEntry', () => {
  it('is expandable when the submodule has tracked or untracked changes', () => {
    expect(
      isExpandableSubmoduleEntry(
        submoduleEntry({
          path: 'flutter_mine',
          submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false }
        })
      )
    ).toBe(true)
    expect(
      isExpandableSubmoduleEntry(
        submoduleEntry({
          path: 'flutter_mine',
          submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: true }
        })
      )
    ).toBe(true)
  })

  it('is expandable for a pointer-only (commit) change so its files can be inspected', () => {
    expect(
      isExpandableSubmoduleEntry(
        submoduleEntry({
          path: 'flutter_mine',
          submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
        })
      )
    ).toBe(true)
  })

  it('is not expandable when the submodule has no changes at all', () => {
    expect(
      isExpandableSubmoduleEntry(
        submoduleEntry({
          path: 'flutter_mine',
          submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: false }
        })
      )
    ).toBe(false)
  })

  it('is not expandable for non-submodule entries or already-inner entries', () => {
    expect(
      isExpandableSubmoduleEntry({ path: 'src/a.ts', status: 'modified', area: 'unstaged' })
    ).toBe(false)
    expect(
      isExpandableSubmoduleEntry(
        submoduleEntry({ path: 'flutter_mine/lib/main.dart', submoduleRoot: 'flutter_mine' })
      )
    ).toBe(false)
  })
})

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

    const [directory] = buildSubmoduleChildNodes(parent, inner)
    expect(directory).toMatchObject({ type: 'directory', path: 'flutter_mine/lib', depth: 3 })
    if (directory.type !== 'directory' || directory.children[0].type !== 'file') {
      throw new Error('Expected a directory containing the renamed file')
    }
    const child = directory.children[0]

    expect(child.path).toBe('flutter_mine/lib/main.dart')
    expect(child.entry.oldPath).toBe('flutter_mine/lib/old-main.dart')
    expect(child.name).toBe('main.dart')
    expect(child.entry.submoduleRoot).toBe('flutter_mine')
    expect(child.entry.status).toBe('renamed')
    expect(child.depth).toBe(4)
    expect(child.area).toBe('unstaged')
  })
})

describe('injectExpandedSubmoduleRows', () => {
  it('passes through unexpanded nodes untouched', () => {
    const node = fileNode(submoduleEntry({ path: 'flutter_mine' }))
    const result = injectExpandedSubmoduleRows([node], new Set(), {}, LOADING, EMPTY)
    expect(result).toEqual([node])
  })

  it('emits a loading placeholder when status is missing or loading', () => {
    const node = fileNode(submoduleEntry({ path: 'flutter_mine' }))
    const result = injectExpandedSubmoduleRows([node], new Set([FLUTTER_KEY]), {}, LOADING, EMPTY)
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({
      type: 'submodule-placeholder',
      state: 'loading',
      message: LOADING,
      submodulePath: 'flutter_mine'
    })
  })

  it('emits an error placeholder carrying the error message', () => {
    const node = fileNode(submoduleEntry({ path: 'flutter_mine' }))
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: { status: 'error', error: 'boom' }
    }
    const result = injectExpandedSubmoduleRows(
      [node],
      new Set([FLUTTER_KEY]),
      statuses,
      LOADING,
      EMPTY
    )
    expect(result[1]).toMatchObject({
      type: 'submodule-placeholder',
      state: 'error',
      message: 'boom'
    })
  })

  it('emits an empty placeholder when the submodule has no inner entries', () => {
    const node = fileNode(submoduleEntry({ path: 'flutter_mine' }))
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: { status: 'loaded', entries: [] }
    }
    const result = injectExpandedSubmoduleRows(
      [node],
      new Set([FLUTTER_KEY]),
      statuses,
      LOADING,
      EMPTY
    )
    expect(result[1]).toMatchObject({
      type: 'submodule-placeholder',
      state: 'empty',
      message: EMPTY
    })
  })

  it('injects child file rows when inner status is loaded', () => {
    const node = fileNode(submoduleEntry({ path: 'flutter_mine' }))
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: {
        status: 'loaded',
        entries: [{ path: 'lib/main.dart', status: 'modified', area: 'unstaged' }]
      }
    }
    const result = injectExpandedSubmoduleRows(
      [node],
      new Set([FLUTTER_KEY]),
      statuses,
      LOADING,
      EMPTY
    )
    expect(result).toHaveLength(3)
    expect(result[1]).toMatchObject({ type: 'directory', path: 'flutter_mine/lib' })
    expect(result[2]).toMatchObject({
      type: 'file',
      path: 'flutter_mine/lib/main.dart'
    })
    const child = result[2]
    if (child.type !== 'file') {
      throw new Error('Expected the submodule child file')
    }
    expect(child.entry.submoduleRoot).toBe('flutter_mine')
  })

  it('shows that capped tree results omit additional submodule changes', () => {
    const node = fileNode(submoduleEntry({ path: 'flutter_mine' }))
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: {
        status: 'loaded',
        entries: [{ path: 'lib/main.dart', status: 'modified', area: 'unstaged' }],
        didHitLimit: true
      }
    }

    const result = injectExpandedSubmoduleRows(
      [node],
      new Set([FLUTTER_KEY]),
      statuses,
      LOADING,
      EMPTY
    )

    expect(result.at(-1)).toMatchObject({
      type: 'submodule-placeholder',
      state: 'truncated',
      submodulePath: 'flutter_mine'
    })
  })

  it('keeps inner staged rows staged for tree-view diff routing', () => {
    const node = fileNode(submoduleEntry({ path: 'flutter_mine' }))
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: {
        status: 'loaded',
        entries: [{ path: 'lib/main.dart', status: 'modified', area: 'staged' }]
      }
    }
    const result = injectExpandedSubmoduleRows(
      [node],
      new Set([FLUTTER_KEY]),
      statuses,
      LOADING,
      EMPTY
    )

    expect(result[2]).toMatchObject({
      type: 'file',
      key: 'staged::flutter_mine/lib/main.dart',
      area: 'staged',
      entry: {
        path: 'flutter_mine/lib/main.dart',
        area: 'staged',
        submoduleRoot: 'flutter_mine'
      }
    })
  })

  it('expands a pointer-only (commit) submodule into its commit-range files', () => {
    const node = fileNode(
      submoduleEntry({
        path: 'flutter_mine',
        submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
      })
    )
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: {
        status: 'loaded',
        entries: [{ path: 'lib/main.dart', status: 'modified', area: 'unstaged' }]
      }
    }
    const result = injectExpandedSubmoduleRows(
      [node],
      new Set([FLUTTER_KEY]),
      statuses,
      LOADING,
      EMPTY
    )
    expect(result).toHaveLength(3)
    expect(result[2]).toMatchObject({ type: 'file', path: 'flutter_mine/lib/main.dart' })
  })

  it('places matching filenames in their folders and keeps child directory actions read-only', () => {
    const node = fileNode(submoduleEntry({ path: 'flutter_mine' }), 1)
    const rows = injectExpandedSubmoduleRows(
      [node],
      new Set([FLUTTER_KEY]),
      {
        [FLUTTER_KEY]: {
          status: 'loaded',
          entries: [
            { path: 'src/index.ts', oldPath: 'src/old.ts', status: 'renamed', area: 'staged' },
            { path: 'tests/index.ts', status: 'untracked', area: 'untracked' }
          ]
        }
      },
      LOADING,
      EMPTY
    )
    expect(rows.map(({ type, key, depth }) => ({ type, key, depth }))).toEqual([
      { type: 'file', key: 'unstaged::flutter_mine', depth: 1 },
      { type: 'directory', key: 'dir::unstaged::flutter_mine/src', depth: 2 },
      { type: 'file', key: 'staged::flutter_mine/src/index.ts', depth: 3 },
      { type: 'directory', key: 'dir::unstaged::flutter_mine/tests', depth: 2 },
      { type: 'file', key: 'untracked::flutter_mine/tests/index.ts', depth: 3 }
    ])
    expect(rows[2]).toMatchObject({
      entry: { oldPath: 'flutter_mine/src/old.ts', submoduleRoot: 'flutter_mine' }
    })
    for (const row of rows) {
      if (row.type === 'directory') {
        expect(getSourceControlDirectoryActionPaths(row)).toEqual({
          stagePaths: [],
          unstagePaths: [],
          discardPaths: []
        })
      }
    }
  })

  it('keeps the staged parent diff area for every file within child folders', () => {
    const parent = fileNode(submoduleEntry({ path: 'flutter_mine', area: 'staged' }))
    parent.area = 'staged'
    const rows = injectExpandedSubmoduleRows(
      [parent],
      new Set(['staged::flutter_mine']),
      {
        'staged::flutter_mine': {
          status: 'loaded',
          entries: [{ path: 'src/index.ts', status: 'untracked', area: 'untracked' }]
        }
      },
      LOADING,
      EMPTY
    )
    expect(rows[1]).toMatchObject({ key: 'dir::staged::flutter_mine/src' })
    expect(rows[2]).toMatchObject({
      key: 'staged::flutter_mine/src/index.ts',
      entry: { area: 'staged', submoduleRoot: 'flutter_mine' }
    })
  })

  it('shows a retryable refresh error before retained children without an empty placeholder', () => {
    const node = fileNode(submoduleEntry({ path: 'flutter_mine' }))
    const rows = injectExpandedSubmoduleRows(
      [node],
      new Set([FLUTTER_KEY]),
      {
        [FLUTTER_KEY]: {
          status: 'loaded',
          entries: [{ path: 'src/index.ts', status: 'modified', area: 'unstaged' }],
          error: 'Connection lost',
          refreshing: true
        }
      },
      LOADING,
      EMPTY
    )
    expect(rows[1]).toMatchObject({
      type: 'submodule-placeholder',
      state: 'error',
      expansionKey: 'unstaged::flutter_mine',
      message: 'Connection lost',
      refreshing: true
    })
    expect(rows[3]).toMatchObject({ type: 'file', path: 'flutter_mine/src/index.ts' })
    const emptyErrorRows = injectExpandedSubmoduleRows(
      [node],
      new Set([FLUTTER_KEY]),
      { [FLUTTER_KEY]: { status: 'loaded', entries: [], error: 'Connection lost' } },
      LOADING,
      EMPTY
    )
    expect(
      emptyErrorRows.map((row) => (row.type === 'submodule-placeholder' ? row.state : row.type))
    ).toEqual(['file', 'error'])
  })

  it('never expands a non-submodule entry that is in the expanded set', () => {
    const node = fileNode({ path: 'src/a.ts', status: 'modified', area: 'unstaged' })
    const result = injectExpandedSubmoduleRows(
      [node],
      new Set(['unstaged::src/a.ts']),
      {},
      LOADING,
      EMPTY
    )
    expect(result).toEqual([node])
  })
})

describe('injectExpandedSubmoduleEntries (list view)', () => {
  it('passes through unexpanded entries untouched', () => {
    const entry = submoduleEntry({ path: 'flutter_mine' })
    const result = injectExpandedSubmoduleEntries([entry], new Set(), {}, LOADING, EMPTY)
    expect(result).toEqual([{ type: 'entry', entry }])
  })

  it('emits a loading placeholder when status is missing', () => {
    const entry = submoduleEntry({ path: 'flutter_mine' })
    const result = injectExpandedSubmoduleEntries(
      [entry],
      new Set([FLUTTER_KEY]),
      {},
      LOADING,
      EMPTY
    )
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({
      type: 'submodule-placeholder',
      state: 'loading',
      submodulePath: 'flutter_mine',
      depth: 1
    })
  })

  it('injects child entries (with submoduleRoot) for a pointer-only commit change', () => {
    const entry = submoduleEntry({
      path: 'flutter_mine',
      submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
    })
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: {
        status: 'loaded',
        entries: [{ path: 'lib/main.dart', status: 'modified', area: 'unstaged' }]
      }
    }
    const result = injectExpandedSubmoduleEntries(
      [entry],
      new Set([FLUTTER_KEY]),
      statuses,
      LOADING,
      EMPTY
    )
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ type: 'entry', entry })
    expect(result[1]).toMatchObject({
      type: 'entry',
      entry: { path: 'flutter_mine/lib/main.dart', submoduleRoot: 'flutter_mine' }
    })
  })

  it('keeps staged-only inner entries staged in list view', () => {
    const entry = submoduleEntry({ path: 'flutter_mine' })
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: {
        status: 'loaded',
        entries: [{ path: 'lib/main.dart', status: 'modified', area: 'staged' }]
      }
    }
    const result = injectExpandedSubmoduleEntries(
      [entry],
      new Set([FLUTTER_KEY]),
      statuses,
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

  it('emits an empty placeholder when loaded with no inner entries', () => {
    const entry = submoduleEntry({ path: 'flutter_mine' })
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: { status: 'loaded', entries: [] }
    }
    const result = injectExpandedSubmoduleEntries(
      [entry],
      new Set([FLUTTER_KEY]),
      statuses,
      LOADING,
      EMPTY
    )
    expect(result[1]).toMatchObject({
      type: 'submodule-placeholder',
      state: 'empty',
      message: EMPTY
    })
  })

  it('retains flat child paths after a failed refresh and exposes its retry key', () => {
    const entry = submoduleEntry({ path: 'flutter_mine' })
    const rows = injectExpandedSubmoduleEntries(
      [entry],
      new Set([FLUTTER_KEY]),
      {
        [FLUTTER_KEY]: {
          status: 'loaded',
          error: 'Offline',
          entries: [
            { path: 'src/index.ts', status: 'modified', area: 'unstaged' },
            { path: 'tests/index.ts', status: 'untracked', area: 'untracked' }
          ]
        }
      },
      LOADING,
      EMPTY
    )
    expect(rows[1]).toMatchObject({
      type: 'submodule-placeholder',
      state: 'error',
      expansionKey: 'unstaged::flutter_mine'
    })
    expect(collectListSelectionEntries(rows).map(({ key }) => key)).toEqual([
      'unstaged::flutter_mine',
      'unstaged::flutter_mine/src/index.ts',
      'untracked::flutter_mine/tests/index.ts'
    ])
  })

  it('shows that capped list results omit additional submodule changes', () => {
    const entry = submoduleEntry({ path: 'flutter_mine' })
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: {
        status: 'loaded',
        entries: [{ path: 'lib/main.dart', status: 'modified', area: 'unstaged' }],
        didHitLimit: true
      }
    }

    const result = injectExpandedSubmoduleEntries(
      [entry],
      new Set([FLUTTER_KEY]),
      statuses,
      LOADING,
      EMPTY
    )

    expect(result.at(-1)).toMatchObject({
      type: 'submodule-placeholder',
      state: 'truncated',
      submodulePath: 'flutter_mine'
    })
  })
})

describe('collectListSelectionEntries', () => {
  it('includes injected submodule child entries and skips placeholders', () => {
    const entry = submoduleEntry({
      path: 'flutter_mine',
      submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
    })
    const statuses: Record<string, SubmoduleStatusState> = {
      [FLUTTER_KEY]: {
        status: 'loaded',
        entries: [{ path: 'lib/main.dart', status: 'modified', area: 'unstaged' }]
      }
    }
    const rows = injectExpandedSubmoduleEntries(
      [entry],
      new Set([FLUTTER_KEY]),
      statuses,
      LOADING,
      EMPTY
    )

    expect(collectListSelectionEntries(rows)).toEqual([
      { key: 'unstaged::flutter_mine', entry, area: 'unstaged' },
      {
        key: 'unstaged::flutter_mine/lib/main.dart',
        entry: {
          path: 'flutter_mine/lib/main.dart',
          status: 'modified',
          area: 'unstaged',
          submoduleRoot: 'flutter_mine'
        },
        area: 'unstaged'
      }
    ])
  })

  it('drops loading placeholders from selection entries', () => {
    const entry = submoduleEntry({ path: 'flutter_mine' })
    const rows = injectExpandedSubmoduleEntries([entry], new Set([FLUTTER_KEY]), {}, LOADING, EMPTY)

    expect(collectListSelectionEntries(rows)).toEqual([
      { key: 'unstaged::flutter_mine', entry, area: 'unstaged' }
    ])
  })
})

describe('getSubmoduleExpansionKey', () => {
  it('separates staged and unstaged rows for the same submodule path', () => {
    expect(getSubmoduleExpansionKey(submoduleEntry({ path: 'flutter_mine', area: 'staged' }))).toBe(
      'staged::flutter_mine'
    )
    expect(
      getSubmoduleExpansionKey(submoduleEntry({ path: 'flutter_mine', area: 'unstaged' }))
    ).toBe(FLUTTER_KEY)
  })

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
