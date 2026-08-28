import { useMemo, type Dispatch, type SetStateAction } from 'react'

import { findTaskPageLinearIssue } from '@/components/task-page-cache-selectors'
import type { LinearPrimaryTeamObservation } from '@/components/task-page-linear-issue-request'
import type { LinearMode, LinearOrderBy } from '@/components/task-page-localized-options'
import type { LinearProjectTab } from '@/components/task-page/linear/linear-issue-grouping'
import { useTaskPageLinearIssueAttachments } from '@/components/task-page/hooks/use-task-page-linear-issue-attachments'
import { useTaskPageLinearIssuePaging } from '@/components/task-page/hooks/use-task-page-linear-issue-paging'
import { useTaskPageLinearIssueTeamOptions } from '@/components/task-page/hooks/use-task-page-linear-issue-team-options'
import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import type { LinearIssueAttributeFilter } from '../../../../../shared/linear/issue-attribute-filter'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearConnectionStatus,
  LinearTeam
} from '../../../../../shared/linear/workspace-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { CacheEntry } from '@/store/github/cache-model'

export function useTaskPageLinearIssueWindow({
  activeLinearIssues,
  linearCacheSnapshot,
  availableTeams,
  defaultLinearTeamSelection,
  linearTeamSelection,
  setLinearTeamSelection,
  linearAttributeFilterWorkspaceId,
  setLinearIssueFiltersByWorkspaceId,
  setLinearIssueLimit,
  setLinearIssuePage,
  setLinearIssueLoadingTargetPage,
  linearPrimaryTeamRef,
  linearAttributeFilter,
  linearSearchInput,
  appliedLinearSearch,
  linearMode,
  activeLinearIssueContextLabel,
  allWorktrees,
  folderWorkspaces,
  selectedLinearWorkspaceId,
  linearStatus,
  linearOrderBy,
  activeLinearIssueCanRequestMore,
  activeLinearIssuePage,
  activeLinearIssueError,
  activeLinearIssueLoading,
  selectedLinearProject,
  linearProjectTab,
  selectedLinearCustomView,
  setLinearProjectIssuePage,
  setLinearCustomViewIssuePage,
  setLinearProjectIssueLoadingTargetPage,
  setLinearCustomViewIssueLoadingTargetPage,
  setLinearProjectIssueLimit,
  setLinearCustomViewIssueLimit,
  activeLinearIssueLimit,
  activeLinearIssueLoadingTargetPage,
  activeLinearIssueHasCollectionError
}: {
  activeLinearIssues: LinearIssue[]
  linearCacheSnapshot: {
    issueCache: Record<string, CacheEntry<LinearIssue>>
    searchCache: Record<string, CacheEntry<LinearIssue[]>>
    listCache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>
  }
  availableTeams: LinearTeam[]
  defaultLinearTeamSelection: string[] | null | undefined
  linearTeamSelection: ReadonlySet<string>
  setLinearTeamSelection: Dispatch<SetStateAction<ReadonlySet<string>>>
  linearAttributeFilterWorkspaceId: string | null
  setLinearIssueFiltersByWorkspaceId: Dispatch<
    SetStateAction<Record<string, LinearIssueAttributeFilter>>
  >
  setLinearIssueLimit: Dispatch<SetStateAction<number>>
  setLinearIssuePage: Dispatch<SetStateAction<number>>
  setLinearIssueLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  linearPrimaryTeamRef: { current: LinearPrimaryTeamObservation | null }
  linearAttributeFilter: LinearIssueAttributeFilter
  linearSearchInput: string
  appliedLinearSearch: string
  linearMode: LinearMode
  activeLinearIssueContextLabel: string | null
  allWorktrees: Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  selectedLinearWorkspaceId: string | null
  linearStatus: LinearConnectionStatus
  linearOrderBy: LinearOrderBy
  activeLinearIssueCanRequestMore: boolean
  activeLinearIssuePage: number
  activeLinearIssueError: string | null
  activeLinearIssueLoading: boolean
  selectedLinearProject: LinearProjectSummary | null
  linearProjectTab: LinearProjectTab
  selectedLinearCustomView: LinearCustomViewSummary | null
  setLinearProjectIssuePage: Dispatch<SetStateAction<number>>
  setLinearCustomViewIssuePage: Dispatch<SetStateAction<number>>
  setLinearProjectIssueLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  setLinearCustomViewIssueLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  setLinearProjectIssueLimit: Dispatch<SetStateAction<number>>
  setLinearCustomViewIssueLimit: Dispatch<SetStateAction<number>>
  activeLinearIssueLimit: number
  activeLinearIssueLoadingTargetPage: number | null
  activeLinearIssueHasCollectionError: boolean
}) {
  const displayedLinearIssues = useMemo(
    () =>
      activeLinearIssues.map(
        (issue) =>
          findTaskPageLinearIssue(
            linearCacheSnapshot.issueCache,
            linearCacheSnapshot.searchCache,
            linearCacheSnapshot.listCache,
            issue.id
          ) ?? issue
      ),
    [
      activeLinearIssues,
      linearCacheSnapshot.issueCache,
      linearCacheSnapshot.listCache,
      linearCacheSnapshot.searchCache
    ]
  )

  const teamOptions = useTaskPageLinearIssueTeamOptions({
    displayedLinearIssues,
    availableTeams,
    defaultLinearTeamSelection,
    linearTeamSelection,
    setLinearTeamSelection,
    linearAttributeFilterWorkspaceId,
    setLinearIssueFiltersByWorkspaceId,
    setLinearIssueLimit,
    setLinearIssuePage,
    setLinearIssueLoadingTargetPage,
    linearPrimaryTeamRef,
    linearAttributeFilter
  })
  const attachments = useTaskPageLinearIssueAttachments({
    linearSearchInput,
    appliedLinearSearch,
    linearMode,
    activeLinearIssueContextLabel,
    allWorktrees,
    folderWorkspaces,
    selectedLinearWorkspaceId,
    linearStatus
  })
  const paging = useTaskPageLinearIssuePaging({
    linearMode,
    displayedLinearIssues,
    appliedLinearSearch,
    activeLinearIssueContextLabel,
    linearTeamSelection,
    linearOrderBy,
    activeLinearIssueCanRequestMore,
    activeLinearIssuePage,
    activeLinearIssueError,
    activeLinearIssueLoading,
    activeLinearIssues,
    selectedLinearProject,
    linearProjectTab,
    selectedLinearCustomView,
    setLinearProjectIssuePage,
    setLinearCustomViewIssuePage,
    setLinearIssuePage,
    setLinearProjectIssueLoadingTargetPage,
    setLinearCustomViewIssueLoadingTargetPage,
    setLinearIssueLoadingTargetPage,
    setLinearProjectIssueLimit,
    setLinearCustomViewIssueLimit,
    setLinearIssueLimit,
    activeLinearIssueLimit,
    activeLinearIssueLoadingTargetPage,
    activeLinearIssueHasCollectionError
  })

  return {
    displayedLinearIssues,
    ...teamOptions,
    ...attachments,
    ...paging
  }
}
