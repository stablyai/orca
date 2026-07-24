import { describe, expect, it } from 'vitest'
import type { GitBranchChangeEntry } from '../../../../shared/types'
import {
  buildGitHistoryCommitFilesRows,
  getGitHistoryCommitFilesRowKey
} from './GitHistoryCommitFiles'

const COMMIT_ID = 'a'.repeat(40)

const entries: GitBranchChangeEntry[] = [
  { path: 'src/index.ts', status: 'modified' },
  { path: 'src/nested/feature.ts', status: 'added' }
]

describe('buildGitHistoryCommitFilesRows', () => {
  it('projects metadata and every transient state into flat detail rows', () => {
    const metadata = { author: 'Test Author', timestamp: 1_700_000_000 }

    expect(
      buildGitHistoryCommitFilesRows({
        commitId: COMMIT_ID,
        viewMode: 'list',
        state: { status: 'loading' },
        collapsedTreeDirs: new Set(),
        canOpenAll: true,
        ...metadata
      }).map((row) => row.kind)
    ).toEqual(['meta', 'loading'])
    expect(
      buildGitHistoryCommitFilesRows({
        commitId: COMMIT_ID,
        viewMode: 'list',
        state: { status: 'error', error: 'load failed' },
        collapsedTreeDirs: new Set(),
        canOpenAll: true,
        ...metadata
      }).map((row) => row.kind)
    ).toEqual(['meta', 'error'])
    expect(
      buildGitHistoryCommitFilesRows({
        commitId: COMMIT_ID,
        viewMode: 'list',
        state: { status: 'ready', entries: [] },
        collapsedTreeDirs: new Set(),
        canOpenAll: true,
        ...metadata
      }).map((row) => row.kind)
    ).toEqual(['meta', 'empty'])
  })

  it('keeps list entries and open-all as stable keyed rows', () => {
    const rows = buildGitHistoryCommitFilesRows({
      commitId: COMMIT_ID,
      viewMode: 'list',
      state: { status: 'ready', entries },
      collapsedTreeDirs: new Set(),
      canOpenAll: true
    })

    expect(rows.map((row) => row.kind)).toEqual(['file', 'file', 'open-all'])
    expect(rows[0]).toMatchObject({ kind: 'file', entry: entries[0], showPathHint: true })
    expect(rows.map(getGitHistoryCommitFilesRowKey)).toEqual([
      `commit-files:${COMMIT_ID}:file:src/index.ts`,
      `commit-files:${COMMIT_ID}:file:src/nested/feature.ts`,
      `commit-files:${COMMIT_ID}:open-all:open-all`
    ])
  })

  it('builds, compacts, namespaces, and collapses tree rows before flattening', () => {
    const expandedRows = buildGitHistoryCommitFilesRows({
      commitId: COMMIT_ID,
      viewMode: 'tree',
      state: { status: 'ready', entries },
      collapsedTreeDirs: new Set(),
      canOpenAll: false
    })
    const rootDirectory = expandedRows.find((row) => row.kind === 'directory')
    if (!rootDirectory || rootDirectory.kind !== 'directory') {
      throw new Error('Missing root directory row')
    }

    expect(rootDirectory.node.key).toContain(`commit:${COMMIT_ID}`)
    expect(expandedRows.filter((row) => row.kind === 'file')).toHaveLength(entries.length)

    const collapsedRows = buildGitHistoryCommitFilesRows({
      commitId: COMMIT_ID,
      viewMode: 'tree',
      state: { status: 'ready', entries },
      collapsedTreeDirs: new Set([rootDirectory.node.key]),
      canOpenAll: false
    })
    expect(collapsedRows.map((row) => row.kind)).toEqual(['directory'])
    expect(collapsedRows[0]).toMatchObject({ kind: 'directory', isCollapsed: true })
  })
})
