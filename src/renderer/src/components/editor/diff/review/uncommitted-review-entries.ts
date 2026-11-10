import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { useAppStore } from '@/store'
import { joinPath } from '@/lib/path'
import type { DiffReviewOwner } from '@/lib/editor/diff-reviewed-files'
import {
  diffReviewKey,
  entryReviewSource,
  reviewEntrySignature
} from '@/lib/editor/diff-reviewed-files'
import type { DiffReviewNavigationEntry } from '@/lib/editor/diff-review-navigation'

// Shared shape for "open this uncommitted row as a preview diff", used by the
// source-control registration and the individual diff's fallback list.
export function buildUncommittedReviewEntries({
  owner,
  worktreeId,
  worktreePath,
  rows,
  executionHostId,
  runtimeEnvironmentId,
  reveal
}: {
  owner: DiffReviewOwner
  worktreeId: string
  worktreePath: string
  rows: readonly GitStatusEntry[]
  executionHostId?: ExecutionHostId
  runtimeEnvironmentId?: string
  reveal?: (entry: GitStatusEntry, source: 'staged' | 'unstaged') => void
}): readonly DiffReviewNavigationEntry[] {
  return rows.map((entry) => ({
    key: diffReviewKey(owner, entry.path, entryReviewSource(entry)),
    entrySignature: reviewEntrySignature(entry),
    open: (placement: { placementWorkspaceId: string; targetGroupId?: string }) => {
      reveal?.(entry, entryReviewSource(entry))
      useAppStore
        .getState()
        .openDiff(
          worktreeId,
          joinPath(worktreePath, entry.path),
          entry.path,
          detectLanguage(entry.path),
          entry.area === 'staged',
          {
            ...placement,
            executionHostId,
            runtimeEnvironmentId,
            preview: true,
            ...(entry.area === 'staged' && entry.oldPath ? { oldPath: entry.oldPath } : {})
          }
        )
    }
  }))
}
