import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  getRuntimeGitRemoteCommitFileUrl,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import { getConnectionId } from '@/lib/connection-context'
import { translate } from '@/i18n/i18n'
import type { GitHistoryItem } from '../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../shared/types'
import type { GitHistoryCommitFileAction } from './GitHistoryCommitFileContextMenu'
import type { SourceControlRowOpenEvent } from './source-control-split-open'

const PERMANENT_COMMIT_FILE_OPEN_EVENT: SourceControlRowOpenEvent = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  openAsPermanent: true
}

type CommitFileBrowserTarget = {
  relativePath: string
  sha: string
}

function resolveCommitFileBrowserTarget(
  item: GitHistoryItem,
  entry: GitBranchChangeEntry
): CommitFileBrowserTarget | null {
  if (entry.status !== 'deleted') {
    return { relativePath: entry.path, sha: item.id }
  }
  const parentId = item.parentIds[0]
  return parentId ? { relativePath: entry.oldPath ?? entry.path, sha: parentId } : null
}

export function useGitHistoryCommitFileActions({
  activeWorktreeId,
  worktreePath,
  activeRepoSettings,
  createBrowserTab,
  openCommitFile,
  copyCommitText
}: {
  activeWorktreeId: string | null | undefined
  worktreePath: string | null
  activeRepoSettings: RuntimeGitContext['settings']
  createBrowserTab: (worktreeId: string, url: string, options: { activate: boolean }) => void
  openCommitFile: (
    item: GitHistoryItem,
    entry: GitBranchChangeEntry,
    event?: SourceControlRowOpenEvent
  ) => void
  copyCommitText: (text: string, label: string) => Promise<void>
}): {
  handleCommitFileAction: (
    action: GitHistoryCommitFileAction,
    item: GitHistoryItem,
    entry: GitBranchChangeEntry
  ) => void
} {
  const handleCommitFileAction = useCallback(
    (
      action: GitHistoryCommitFileAction,
      item: GitHistoryItem,
      entry: GitBranchChangeEntry
    ): void => {
      if (action === 'open-diff') {
        openCommitFile(item, entry, PERMANENT_COMMIT_FILE_OPEN_EVENT)
        return
      }
      if (action === 'copy-relative-path') {
        void copyCommitText(
          entry.path,
          translate('auto.components.right.sidebar.SourceControl.4e27a9bc16', 'Relative path')
        )
        return
      }
      if (action === 'copy-commit-hash') {
        void copyCommitText(
          item.id,
          translate('auto.components.right.sidebar.SourceControl.d172a4f068', 'Commit hash')
        )
        return
      }
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      const target = resolveCommitFileBrowserTarget(item, entry)
      if (!target) {
        return
      }
      void getRuntimeGitRemoteCommitFileUrl(
        {
          settings: activeRepoSettings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId: getConnectionId(activeWorktreeId) ?? undefined
        },
        target
      )
        .then((result) => {
          if (result.status === 'ok') {
            createBrowserTab(activeWorktreeId, result.url, { activate: true })
            return
          }
          if (result.status === 'commit-not-on-remote') {
            toast.error(
              translate(
                'auto.components.right.sidebar.SourceControl.56be207fbb',
                'No remotes found that contain this commit'
              )
            )
            return
          }
          toast.error(
            translate(
              'auto.components.right.sidebar.SourceControl.04a5d7239b',
              'This repository has no supported web remote'
            )
          )
        })
        .catch(() => {
          toast.error(
            translate(
              'auto.components.right.sidebar.SourceControl.5f38bacd27',
              'Failed to open file in browser'
            )
          )
        })
    },
    [
      activeRepoSettings,
      activeWorktreeId,
      copyCommitText,
      createBrowserTab,
      openCommitFile,
      worktreePath
    ]
  )

  return { handleCommitFileAction }
}
