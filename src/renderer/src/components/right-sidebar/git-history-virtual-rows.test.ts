import { describe, expect, it } from 'vitest'
import type { GitHistoryItemViewModel } from '../../../../shared/git-history-graph'
import {
  buildGitHistoryVirtualRows,
  estimateGitHistoryVirtualRowHeight,
  getGitHistoryVirtualRowKey
} from './git-history-virtual-rows'

function makeViewModel(
  id: string,
  kind: GitHistoryItemViewModel['kind'] = 'node'
): GitHistoryItemViewModel {
  return {
    historyItem: {
      id,
      parentIds: [],
      subject: id,
      message: id
    },
    inputSwimlanes: [],
    outputSwimlanes: [],
    kind
  }
}

describe('buildGitHistoryVirtualRows', () => {
  it('interleaves expanded commit details with later commit rows in one projection', () => {
    const first = makeViewModel('first')
    const second = makeViewModel('second')
    const entries = Array.from({ length: 500 }, (_, index) => ({
      path: `src/file-${String(index).padStart(3, '0')}.ts`,
      status: 'modified' as const
    }))

    const rows = buildGitHistoryVirtualRows({
      viewModels: [first, second],
      expandedCommitIds: new Set(['first']),
      filesByCommit: { first: { status: 'ready', entries } },
      viewMode: 'list',
      collapsedTreeDirs: new Set(),
      canOpenAll: false
    })

    expect(rows).toHaveLength(502)
    expect(rows[0]).toMatchObject({ kind: 'commit', viewModel: first })
    expect(rows[1]).toMatchObject({
      kind: 'detail',
      viewModel: first,
      detail: { kind: 'file', entry: entries[0] }
    })
    expect(rows.at(-1)).toMatchObject({ kind: 'commit', viewModel: second })
    expect(new Set(rows.map(getGitHistoryVirtualRowKey))).toHaveProperty('size', rows.length)
  })

  it('does not project details below synthetic boundary rows', () => {
    const boundary = makeViewModel('incoming', 'incoming-changes')
    const rows = buildGitHistoryVirtualRows({
      viewModels: [boundary],
      expandedCommitIds: new Set(['incoming']),
      filesByCommit: { incoming: { status: 'loading' } },
      viewMode: 'list',
      collapsedTreeDirs: new Set(),
      canOpenAll: false
    })

    expect(rows).toEqual([{ kind: 'commit', viewModel: boundary }])
  })

  it('estimates commit rows separately from detail rows', () => {
    const viewModel = makeViewModel('commit')
    const [commitRow, detailRow] = buildGitHistoryVirtualRows({
      viewModels: [viewModel],
      expandedCommitIds: new Set(['commit']),
      filesByCommit: { commit: { status: 'loading' } },
      viewMode: 'list',
      collapsedTreeDirs: new Set(),
      canOpenAll: false
    })

    if (!commitRow || !detailRow) {
      throw new Error('Missing projected history rows')
    }
    expect(estimateGitHistoryVirtualRowHeight(commitRow)).toBeGreaterThan(
      estimateGitHistoryVirtualRowHeight(detailRow)
    )
  })
})
