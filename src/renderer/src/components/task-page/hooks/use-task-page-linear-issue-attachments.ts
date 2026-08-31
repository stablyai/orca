import { useEffect, useMemo, useRef } from 'react'

import { isLinearIssueSearchActive } from '@/components/task-page-linear-issue-request'
import { buildLinearIssueWorkspaceAttachmentIndex } from '@/lib/linear-issue-workspace-attachment'
import { folderWorkspaceToWorktree } from '../../../../../shared/folder-workspace-worktree'
import {
  collectLinkedLinearIssueRefsFromWorktrees,
  linkedLinearIssueRefsSignature
} from '@/components/task-page-linear-in-orca-issues'
import type { LinearMode } from '@/components/task-page-localized-options'
import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import type { LinearConnectionStatus } from '../../../../../shared/linear/workspace-types'
import type { Worktree } from '../../../../../shared/worktree/types'

export function useTaskPageLinearIssueAttachments({
  linearSearchInput,
  appliedLinearSearch,
  linearMode,
  activeLinearIssueContextLabel,
  allWorktrees,
  folderWorkspaces,
  selectedLinearWorkspaceId,
  linearStatus
}: {
  linearSearchInput: string
  appliedLinearSearch: string
  linearMode: LinearMode
  activeLinearIssueContextLabel: string | null
  allWorktrees: Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  selectedLinearWorkspaceId: string | null
  linearStatus: LinearConnectionStatus
}) {
  const linearSearchActive = isLinearIssueSearchActive(linearSearchInput, appliedLinearSearch)
  const showLinearAttributeFilters =
    linearMode === 'issues' && !activeLinearIssueContextLabel && !linearSearchActive

  // Why: one pass over worktrees per list render; per-row scans re-parsed every link.
  const linearAttachmentWorkspaces = useMemo(
    () => [...allWorktrees, ...folderWorkspaces.map(folderWorkspaceToWorktree)],
    [allWorktrees, folderWorkspaces]
  )
  const linearIssueAttachmentIndex = useMemo(
    () => buildLinearIssueWorkspaceAttachmentIndex(linearAttachmentWorkspaces),
    [linearAttachmentWorkspaces]
  )
  const inOrcaLinkedLinearRefs = useMemo(
    () =>
      collectLinkedLinearIssueRefsFromWorktrees(linearAttachmentWorkspaces, {
        workspaceId: selectedLinearWorkspaceId,
        workspaces: linearStatus.workspaces ?? []
      }),
    [linearAttachmentWorkspaces, linearStatus.workspaces, selectedLinearWorkspaceId]
  )
  const inOrcaLinkedLinearRefsSignature = useMemo(
    () => linkedLinearIssueRefsSignature(inOrcaLinkedLinearRefs),
    [inOrcaLinkedLinearRefs]
  )
  const inOrcaLinkedLinearRefsRef = useRef(inOrcaLinkedLinearRefs)
  // Keep latest linked refs for the in-orca loader without re-running it on identity churn.
  useEffect(() => {
    inOrcaLinkedLinearRefsRef.current = inOrcaLinkedLinearRefs
  }, [inOrcaLinkedLinearRefs])

  return {
    linearSearchActive,
    showLinearAttributeFilters,
    linearAttachmentWorkspaces,
    linearIssueAttachmentIndex,
    inOrcaLinkedLinearRefs,
    inOrcaLinkedLinearRefsSignature,
    inOrcaLinkedLinearRefsRef
  }
}
