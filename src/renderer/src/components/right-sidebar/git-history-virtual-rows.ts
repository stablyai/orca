import type { GitHistoryItemViewModel } from '../../../../shared/git-history-graph'
import type { SourceControlViewMode } from '../../../../shared/types'
import {
  buildGitHistoryCommitFilesRows,
  getGitHistoryCommitFilesRowKey,
  type GitHistoryCommitFilesRow,
  type GitHistoryCommitFilesState
} from './GitHistoryCommitFiles'

export type GitHistoryVirtualRow =
  | { kind: 'commit'; viewModel: GitHistoryItemViewModel }
  | {
      kind: 'detail'
      viewModel: GitHistoryItemViewModel
      detail: GitHistoryCommitFilesRow
    }

export function buildGitHistoryVirtualRows({
  viewModels,
  expandedCommitIds,
  filesByCommit,
  viewMode,
  collapsedTreeDirs,
  canOpenAll
}: {
  viewModels: readonly GitHistoryItemViewModel[]
  expandedCommitIds: ReadonlySet<string>
  filesByCommit: Readonly<Record<string, GitHistoryCommitFilesState>>
  viewMode: SourceControlViewMode
  collapsedTreeDirs: ReadonlySet<string>
  canOpenAll: boolean
}): GitHistoryVirtualRow[] {
  const rows: GitHistoryVirtualRow[] = []
  for (const viewModel of viewModels) {
    rows.push({ kind: 'commit', viewModel })
    const isBoundary =
      viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes'
    const item = viewModel.historyItem
    if (isBoundary || !expandedCommitIds.has(item.id)) {
      continue
    }

    const detailRows = buildGitHistoryCommitFilesRows({
      commitId: item.id,
      viewMode,
      state: filesByCommit[item.id] ?? { status: 'loading' },
      author: item.author,
      timestamp: item.timestamp,
      collapsedTreeDirs,
      canOpenAll
    })
    for (const detail of detailRows) {
      rows.push({ kind: 'detail', viewModel, detail })
    }
  }
  return rows
}

export function getGitHistoryVirtualRowKey(row: GitHistoryVirtualRow): string {
  if (row.kind === 'commit') {
    return `history:${row.viewModel.historyItem.id}`
  }
  return `history:${getGitHistoryCommitFilesRowKey(row.detail)}`
}

export function estimateGitHistoryVirtualRowHeight(row: GitHistoryVirtualRow): number {
  if (row.kind === 'commit') {
    return 28
  }
  return row.detail.kind === 'meta' ? 20 : 24
}
