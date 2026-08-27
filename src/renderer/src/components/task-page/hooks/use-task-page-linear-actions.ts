import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { buildLinearIssueLinkedWorkItem } from '@/lib/linear-linked-work-item'
import { openLinearIssueWorkspaceOrStart } from '@/lib/linear-issue-workspace-open'
import { getLinearIssueWorkspaceName } from '../../../../../shared/workspace-name'
import type { LinearMode } from '@/components/task-page-localized-options'
import type { LinearProjectTab } from '@/components/task-page/linear/linear-issue-grouping'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearTeam,
  LinearWorkspaceSelection
} from '../../../../../shared/linear/workspace-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { LinearSlice } from '@/store/slices/linear'
import type { AppState } from '@/store/types'

export function useTaskPageLinearActions({
  linearTaskSourceContext,
  openModal,
  clearSelectedLinearIssue,
  setSelectedLinearProject,
  setSelectedLinearProjectDetail,
  setSelectedLinearCustomView,
  setLinearProjectParentView,
  setLinearProjectTab,
  setLinearProjectsResult,
  setLinearCustomViewsResult,
  setLinearProjectIssuesResult,
  setLinearCustomViewIssuesResult,
  setLinearCustomViewProjectsResult,
  setLinearProjectDetailError,
  setLinearProjectsError,
  setLinearCustomViewsError,
  setLinearCustomViewContentsError,
  setTaskResumeState,
  linearMode,
  linearContextResumeAttemptedRef,
  setLinearIssues,
  setLinearError,
  setLinearLoading,
  selectLinearWorkspace,
  setLinearTeamRefreshNonce,
  setLinearTeamSelection,
  updateSettings,
  checkLinearConnection,
  listLinearTeams,
  selectedLinearWorkspaceId,
  setAvailableTeams,
  setLinearRefreshNonce
}: {
  linearTaskSourceContext: TaskSourceContext | null
  openModal: AppState['openModal']
  clearSelectedLinearIssue: () => void
  setSelectedLinearProject: Dispatch<SetStateAction<LinearProjectSummary | null>>
  setSelectedLinearProjectDetail: Dispatch<SetStateAction<LinearProjectDetail | null>>
  setSelectedLinearCustomView: Dispatch<SetStateAction<LinearCustomViewSummary | null>>
  setLinearProjectParentView: Dispatch<SetStateAction<LinearCustomViewSummary | null>>
  setLinearProjectTab: Dispatch<SetStateAction<LinearProjectTab>>
  setLinearProjectsResult: Dispatch<SetStateAction<LinearCollectionResult<LinearProjectSummary>>>
  setLinearCustomViewsResult: Dispatch<
    SetStateAction<LinearCollectionResult<LinearCustomViewSummary>>
  >
  setLinearProjectIssuesResult: Dispatch<SetStateAction<LinearCollectionResult<LinearIssue>>>
  setLinearCustomViewIssuesResult: Dispatch<SetStateAction<LinearCollectionResult<LinearIssue>>>
  setLinearCustomViewProjectsResult: Dispatch<
    SetStateAction<LinearCollectionResult<LinearProjectSummary>>
  >
  setLinearProjectDetailError: Dispatch<SetStateAction<string | null>>
  setLinearProjectsError: Dispatch<SetStateAction<string | null>>
  setLinearCustomViewsError: Dispatch<SetStateAction<string | null>>
  setLinearCustomViewContentsError: Dispatch<SetStateAction<string | null>>
  setTaskResumeState: AppState['setTaskResumeState']
  linearMode: LinearMode
  linearContextResumeAttemptedRef: { current: boolean }
  setLinearIssues: Dispatch<SetStateAction<LinearIssue[]>>
  setLinearError: Dispatch<SetStateAction<string | null>>
  setLinearLoading: Dispatch<SetStateAction<boolean>>
  selectLinearWorkspace: LinearSlice['selectLinearWorkspace']
  setLinearTeamRefreshNonce: Dispatch<SetStateAction<number>>
  setLinearTeamSelection: Dispatch<SetStateAction<ReadonlySet<string>>>
  updateSettings: AppState['updateSettings']
  checkLinearConnection: LinearSlice['checkLinearConnection']
  listLinearTeams: LinearSlice['listLinearTeams']
  selectedLinearWorkspaceId: string | null
  setAvailableTeams: Dispatch<SetStateAction<LinearTeam[]>>
  setLinearRefreshNonce: Dispatch<SetStateAction<number>>
}) {
  // Why: Linear ids are strings (e.g. "ENG-123") but the provider-generic shape needs a numeric number, so the adapter uses 0 as placeholder.
  const openComposerForLinearItem = useCallback(
    (issue: LinearIssue): void => {
      const linkedWorkItem = buildLinearIssueLinkedWorkItem(issue)
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext: linearTaskSourceContext,
        prefilledName: getLinearIssueWorkspaceName(issue),
        telemetrySource: 'sidebar'
      })
    },
    [linearTaskSourceContext, openModal]
  )

  const handleUseLinearItem = useCallback(
    (issue: LinearIssue): void => {
      // Why: like handleUseWorkItem — open the pre-filled dialog instead of creating the worktree directly, so the user confirms name/agent/setup.
      useAppStore.getState().recordFeatureInteraction('linear-tasks')
      openComposerForLinearItem(issue)
    },
    [openComposerForLinearItem]
  )

  const handleOpenOrUseLinearItem = useCallback(
    (issue: LinearIssue): void => {
      if (openLinearIssueWorkspaceOrStart(issue, () => handleUseLinearItem(issue)) === 'opened') {
        useAppStore.getState().recordFeatureInteraction('linear-tasks')
      }
    },
    [handleUseLinearItem]
  )

  const handleLinearWorkspaceChange = useCallback(
    (workspaceId: LinearWorkspaceSelection): void => {
      clearSelectedLinearIssue()
      setSelectedLinearProject(null)
      setSelectedLinearProjectDetail(null)
      setSelectedLinearCustomView(null)
      setLinearProjectParentView(null)
      setLinearProjectTab('overview')
      setLinearProjectsResult({ items: [] })
      setLinearCustomViewsResult({ items: [] })
      setLinearProjectIssuesResult({ items: [] })
      setLinearCustomViewIssuesResult({ items: [] })
      setLinearCustomViewProjectsResult({ items: [] })
      setLinearProjectDetailError(null)
      setLinearProjectsError(null)
      setLinearCustomViewsError(null)
      setLinearCustomViewContentsError(null)
      setTaskResumeState({
        linearMode,
        linearContext: undefined
      })
      linearContextResumeAttemptedRef.current = false
      setLinearIssues([])
      setLinearError(null)
      setLinearLoading(true)
      void selectLinearWorkspace(workspaceId)
        .then(() => {
          setLinearTeamRefreshNonce((n) => n + 1)
        })
        .catch(() => {
          setLinearLoading(false)
          toast.error(
            translate('auto.components.TaskPage.d0d570b306', 'Failed to switch Linear workspace.')
          )
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the remaining referenced setters and refs are stable useState/useRef identities passed in as props.
    [clearSelectedLinearIssue, linearMode, selectLinearWorkspace, setTaskResumeState]
  )

  const handleLinearTeamSelectionChange = useCallback(
    (next: ReadonlySet<string>, persisted: string[] | null): void => {
      setLinearTeamSelection(new Set(next))
      void updateSettings({ defaultLinearTeamSelection: persisted }).catch(() => {
        toast.error(
          translate('auto.components.TaskPage.3f594861a5', 'Failed to save team selection.')
        )
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the remaining referenced setters and refs are stable useState/useRef identities passed in as props.
    [updateSettings]
  )

  const handleLinearScopeOpen = useCallback((): void => {
    void checkLinearConnection(true)
    void listLinearTeams(selectedLinearWorkspaceId, { force: true })
      .then((teams) => {
        setAvailableTeams(teams)
      })
      .catch(() => {
        console.warn('[TaskPage] Failed to refresh Linear teams')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the remaining referenced setters and refs are stable useState/useRef identities passed in as props.
  }, [checkLinearConnection, listLinearTeams, selectedLinearWorkspaceId])

  const handleLinearAccessConnected = useCallback((): void => {
    setLinearTeamRefreshNonce((n) => n + 1)
    setLinearRefreshNonce((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the remaining referenced setters and refs are stable useState/useRef identities passed in as props.
  }, [])

  return {
    openComposerForLinearItem,
    handleUseLinearItem,
    handleOpenOrUseLinearItem,
    handleLinearWorkspaceChange,
    handleLinearTeamSelectionChange,
    handleLinearScopeOpen,
    handleLinearAccessConnected
  }
}
