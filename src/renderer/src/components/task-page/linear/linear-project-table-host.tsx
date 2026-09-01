import React from 'react'

import {
  LinearCollectionNotice,
  LinearProjectTable
} from '@/components/linear-project-view-surfaces'
import { translate } from '@/i18n/i18n'
import type { LinearProjectSummary } from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearWorkspaceSelection
} from '../../../../../shared/linear/workspace-types'
import type { LinearProjectTab } from './linear-issue-grouping'

export type LinearProjectTableHostProps = {
  linearProjectsError: string | null
  linearProjectsResult: LinearCollectionResult<LinearProjectSummary>
  linearProjectsLoading: boolean
  selectedLinearWorkspaceId: LinearWorkspaceSelection | null
  openLinearProjectContext: (project: LinearProjectSummary) => void
  setLinearProjectTab: (tab: LinearProjectTab) => void
}

export function LinearProjectTableHost({
  linearProjectsError,
  linearProjectsResult,
  linearProjectsLoading,
  selectedLinearWorkspaceId,
  openLinearProjectContext,
  setLinearProjectTab
}: LinearProjectTableHostProps): React.JSX.Element {
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="grid h-8 flex-none items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground grid-cols-[minmax(180px,1.5fr)_110px_100px_90px_120px_110px_80px_70px]">
        <span>{translate('auto.components.TaskPage.00022ec0ba', 'Project')}</span>
        <span>{translate('auto.components.TaskPage.154b0fa623', 'Status')}</span>
        <span>{translate('auto.components.TaskPage.8a07f21e76', 'Health')}</span>
        <span>{translate('auto.components.TaskPage.c8d5bec5f7', 'Priority')}</span>
        <span>{translate('auto.components.TaskPage.34da8ac06c', 'Lead')}</span>
        <span>{translate('auto.components.TaskPage.7da41c9225', 'Target')}</span>
        <span>{translate('auto.components.TaskPage.dfc0c79bd8', 'Issues')}</span>
        <span />
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto scrollbar-sleek">
        {linearProjectsError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {linearProjectsError}
          </div>
        ) : null}
        <LinearProjectTable
          projects={linearProjectsResult.items}
          loading={linearProjectsLoading}
          hasError={!!linearProjectsResult.errors?.length}
          workspaceSelection={selectedLinearWorkspaceId}
          onSelectProject={openLinearProjectContext}
          onOpenProject={(project) => {
            if (project.url) {
              void window.api.shell.openUrl(project.url)
            }
          }}
          onUseProjectIssues={(project) => {
            openLinearProjectContext(project)
            setLinearProjectTab('issues')
          }}
        />
      </div>
      <LinearCollectionNotice
        errors={linearProjectsResult.errors}
        hasMore={linearProjectsResult.hasMore}
        count={linearProjectsResult.items.length}
        label={translate('auto.components.TaskPage.b39fe6511d', 'projects')}
      />
    </div>
  )
}
