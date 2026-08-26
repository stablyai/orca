import React from 'react'

import { LinearProjectOverview } from '@/components/linear-project-view-surfaces'
import type {
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type { TaskResumeState } from '../../../../../shared/ui-chrome-types'
import type { LinearMode } from '@/components/task-page-localized-options'
import type { LinearProjectTab } from './linear-issue-grouping'

export type LinearProjectOverviewHostProps = {
  selectedLinearProject: LinearProjectSummary
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
}

export function LinearProjectOverviewHost({
  selectedLinearProject,
  selectedLinearProjectDetail,
  linearProjectDetailLoading,
  linearProjectDetailError,
  linearProjectParentView,
  setSelectedLinearProject,
  setSelectedLinearProjectDetail,
  setLinearProjectTab,
  setLinearMode,
  setSelectedLinearCustomView,
  setTaskResumeState,
  setLinearProjectParentView,
  setLinearRefreshNonce
}: LinearProjectOverviewHostProps): React.JSX.Element {
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <LinearProjectOverview
        project={selectedLinearProjectDetail ?? selectedLinearProject}
        loading={linearProjectDetailLoading}
        error={linearProjectDetailError}
        onBack={() => {
          if (linearProjectParentView) {
            setSelectedLinearProject(null)
            setSelectedLinearProjectDetail(null)
            setLinearProjectTab('overview')
            setLinearMode('views')
            setSelectedLinearCustomView(linearProjectParentView)
            setTaskResumeState(
              linearProjectParentView.workspaceId
                ? {
                    linearMode: 'views',
                    linearContext: {
                      kind: 'view',
                      id: linearProjectParentView.id,
                      workspaceId: linearProjectParentView.workspaceId,
                      model: linearProjectParentView.model
                    }
                  }
                : {
                    linearMode: 'views',
                    linearContext: undefined
                  }
            )
            setLinearProjectParentView(null)
            return
          }
          setSelectedLinearProject(null)
          setSelectedLinearProjectDetail(null)
          setLinearProjectParentView(null)
          setLinearProjectTab('overview')
          setTaskResumeState({ linearContext: undefined })
        }}
        onOpenProject={(project) => {
          if (project.url) {
            void window.api.shell.openUrl(project.url)
          }
        }}
        onRefresh={() => setLinearRefreshNonce((n) => n + 1)}
        onOpenIssues={() => setLinearProjectTab('issues')}
      />
    </div>
  )
}
