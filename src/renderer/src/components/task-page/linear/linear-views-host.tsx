import React from 'react'

import LinearIssueWorkspace from '@/components/LinearIssueWorkspace'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearWorkspaceSelection
} from '../../../../../shared/linear/workspace-types'
import type { TaskResumeState } from '../../../../../shared/ui-chrome-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { LinearMode } from '@/components/task-page-localized-options'
import { LinearConnectEmpty, LinearStatusLoading } from './linear-connect-empty'
import { LinearCustomViewProjectsHost, LinearCustomViewTableHost } from './linear-custom-view-host'
import type { LinearProjectTab } from './linear-issue-grouping'
import { LinearIssueListHost, type LinearIssueListHostProps } from './linear-issue-list-host'
import { LinearProjectOverviewHost } from './linear-project-overview-host'
import { LinearProjectTableHost } from './linear-project-table-host'

export type LinearViewsHostProps = {
  selectedLinearIssue: LinearIssue | null
  activeLinearIssueContextLabel: string | null
  handleUseLinearItem: (issue: LinearIssue) => void
  openRelatedLinearIssue: (issue: LinearIssue) => void
  closeTaskDetailPage: () => void
  linearDetailSourceContext: TaskSourceContext | null
  linearStatusReady: boolean
  linearConnected: boolean
  setLinearConnectOpen: (open: boolean) => void
  selectedLinearProject: LinearProjectSummary | null
  linearProjectTab: LinearProjectTab
  selectedLinearProjectDetail: LinearProjectDetail | null
  linearProjectDetailLoading: boolean
  linearProjectDetailError: string | null
  linearProjectParentView: LinearCustomViewSummary | null
  setSelectedLinearProject: (project: LinearProjectSummary | null) => void
  setSelectedLinearProjectDetail: (detail: LinearProjectDetail | null) => void
  setLinearProjectTab: (tab: LinearProjectTab) => void
  setLinearMode: (mode: LinearMode) => void
  setSelectedLinearCustomView: (view: LinearCustomViewSummary | null) => void
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  setLinearProjectParentView: (view: LinearCustomViewSummary | null) => void
  setLinearRefreshNonce: React.Dispatch<React.SetStateAction<number>>
  linearMode: LinearMode
  linearProjectsError: string | null
  linearProjectsResult: LinearCollectionResult<LinearProjectSummary>
  linearProjectsLoading: boolean
  selectedLinearWorkspaceId: LinearWorkspaceSelection | null
  openLinearProjectContext: (
    project: LinearProjectSummary,
    options?: { parentView?: LinearCustomViewSummary | null }
  ) => void
  selectedLinearCustomView: LinearCustomViewSummary | null
  linearCustomViewsError: string | null
  linearCustomViewsResult: LinearCollectionResult<LinearCustomViewSummary>
  linearCustomViewsLoading: boolean
  openLinearCustomViewContext: (view: LinearCustomViewSummary) => void
  linearCustomViewContentsError: string | null
  linearCustomViewProjectsResult: LinearCollectionResult<LinearProjectSummary>
  linearCustomViewContentsLoading: boolean
  issueList: LinearIssueListHostProps
}

export function LinearViewsHost(props: LinearViewsHostProps): React.JSX.Element {
  if (props.selectedLinearIssue) {
    return (
      <LinearIssueWorkspace
        issue={props.selectedLinearIssue}
        variant="page"
        backLabel={props.activeLinearIssueContextLabel ?? 'Linear list'}
        onUse={props.handleUseLinearItem}
        onOpenIssue={props.openRelatedLinearIssue}
        onClose={props.closeTaskDetailPage}
        sourceContext={props.linearDetailSourceContext}
      />
    )
  }

  if (!props.linearStatusReady) {
    return <LinearStatusLoading />
  }

  if (!props.linearConnected) {
    return <LinearConnectEmpty onOpenConnect={() => props.setLinearConnectOpen(true)} />
  }

  if (props.selectedLinearProject && props.linearProjectTab === 'overview') {
    return (
      <LinearProjectOverviewHost
        selectedLinearProject={props.selectedLinearProject}
        selectedLinearProjectDetail={props.selectedLinearProjectDetail}
        linearProjectDetailLoading={props.linearProjectDetailLoading}
        linearProjectDetailError={props.linearProjectDetailError}
        linearProjectParentView={props.linearProjectParentView}
        setSelectedLinearProject={props.setSelectedLinearProject}
        setSelectedLinearProjectDetail={props.setSelectedLinearProjectDetail}
        setLinearProjectTab={props.setLinearProjectTab}
        setLinearMode={props.setLinearMode}
        setSelectedLinearCustomView={props.setSelectedLinearCustomView}
        setTaskResumeState={props.setTaskResumeState}
        setLinearProjectParentView={props.setLinearProjectParentView}
        setLinearRefreshNonce={props.setLinearRefreshNonce}
      />
    )
  }

  if (props.linearMode === 'projects' && !props.selectedLinearProject) {
    return (
      <LinearProjectTableHost
        linearProjectsError={props.linearProjectsError}
        linearProjectsResult={props.linearProjectsResult}
        linearProjectsLoading={props.linearProjectsLoading}
        selectedLinearWorkspaceId={props.selectedLinearWorkspaceId}
        openLinearProjectContext={props.openLinearProjectContext}
        setLinearProjectTab={props.setLinearProjectTab}
      />
    )
  }

  if (props.linearMode === 'views' && !props.selectedLinearCustomView) {
    return (
      <LinearCustomViewTableHost
        linearCustomViewsError={props.linearCustomViewsError}
        linearCustomViewsResult={props.linearCustomViewsResult}
        linearCustomViewsLoading={props.linearCustomViewsLoading}
        selectedLinearWorkspaceId={props.selectedLinearWorkspaceId}
        openLinearCustomViewContext={props.openLinearCustomViewContext}
      />
    )
  }

  if (props.selectedLinearCustomView?.model === 'project' && !props.selectedLinearProject) {
    return (
      <LinearCustomViewProjectsHost
        selectedLinearCustomView={props.selectedLinearCustomView}
        setSelectedLinearCustomView={props.setSelectedLinearCustomView}
        setLinearProjectParentView={props.setLinearProjectParentView}
        setTaskResumeState={props.setTaskResumeState}
        linearCustomViewContentsError={props.linearCustomViewContentsError}
        linearCustomViewProjectsResult={props.linearCustomViewProjectsResult}
        linearCustomViewContentsLoading={props.linearCustomViewContentsLoading}
        selectedLinearWorkspaceId={props.selectedLinearWorkspaceId}
        openLinearProjectContext={props.openLinearProjectContext}
        setLinearProjectTab={props.setLinearProjectTab}
      />
    )
  }

  return <LinearIssueListHost {...props.issueList} />
}
