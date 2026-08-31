import React from 'react'
import { ChevronLeft, ExternalLink } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  LinearCollectionNotice,
  LinearCustomViewTable,
  LinearProjectTable
} from '@/components/linear-project-view-surfaces'
import { translate } from '@/i18n/i18n'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearWorkspaceSelection
} from '../../../../../shared/linear/workspace-types'
import type { TaskResumeState } from '../../../../../shared/ui-chrome-types'
import type { LinearProjectTab } from './linear-issue-grouping'

export function LinearCustomViewTableHost({
  linearCustomViewsError,
  linearCustomViewsResult,
  linearCustomViewsLoading,
  selectedLinearWorkspaceId,
  openLinearCustomViewContext
}: {
  linearCustomViewsError: string | null
  linearCustomViewsResult: LinearCollectionResult<LinearCustomViewSummary>
  linearCustomViewsLoading: boolean
  selectedLinearWorkspaceId: LinearWorkspaceSelection | null
  openLinearCustomViewContext: (view: LinearCustomViewSummary) => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="grid h-8 flex-none items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground grid-cols-[minmax(220px,1.5fr)_120px_120px_120px_130px_60px]">
        <span>{translate('auto.components.TaskPage.9c57663908', 'View')}</span>
        <span>{translate('auto.components.TaskPage.0aa8525950', 'Model')}</span>
        <span>{translate('auto.components.TaskPage.a04fe7ba73', 'Visibility')}</span>
        <span>{translate('auto.components.TaskPage.b4e10f096e', 'Owner')}</span>
        <span>{translate('auto.components.TaskPage.f362667d55', 'Updated')}</span>
        <span />
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto scrollbar-sleek">
        {linearCustomViewsError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {linearCustomViewsError}
          </div>
        ) : null}
        <LinearCustomViewTable
          views={linearCustomViewsResult.items}
          loading={linearCustomViewsLoading}
          hasError={!!linearCustomViewsResult.errors?.length}
          workspaceSelection={selectedLinearWorkspaceId}
          onSelectView={openLinearCustomViewContext}
          onOpenView={(view) => {
            if (view.url) {
              void window.api.shell.openUrl(view.url)
            }
          }}
        />
      </div>
      <LinearCollectionNotice
        errors={linearCustomViewsResult.errors}
        hasMore={linearCustomViewsResult.hasMore}
        count={linearCustomViewsResult.items.length}
        label={translate('auto.components.TaskPage.3cb855080f', 'views')}
      />
    </div>
  )
}

export function LinearCustomViewProjectsHost({
  selectedLinearCustomView,
  setSelectedLinearCustomView,
  setLinearProjectParentView,
  setTaskResumeState,
  linearCustomViewContentsError,
  linearCustomViewProjectsResult,
  linearCustomViewContentsLoading,
  selectedLinearWorkspaceId,
  openLinearProjectContext,
  setLinearProjectTab
}: {
  selectedLinearCustomView: LinearCustomViewSummary
  setSelectedLinearCustomView: (view: LinearCustomViewSummary | null) => void
  setLinearProjectParentView: (view: LinearCustomViewSummary | null) => void
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  linearCustomViewContentsError: string | null
  linearCustomViewProjectsResult: LinearCollectionResult<LinearProjectSummary>
  linearCustomViewContentsLoading: boolean
  selectedLinearWorkspaceId: LinearWorkspaceSelection | null
  openLinearProjectContext: (
    project: LinearProjectSummary,
    options?: { parentView?: LinearCustomViewSummary | null }
  ) => void
  setLinearProjectTab: (tab: LinearProjectTab) => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              setSelectedLinearCustomView(null)
              setLinearProjectParentView(null)
              setTaskResumeState({ linearContext: undefined })
            }}
            aria-label={translate('auto.components.TaskPage.bc06ed0fb0', 'Back to views')}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">
              {selectedLinearCustomView.name}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {translate('auto.components.TaskPage.733b8f2421', 'Linear / Views')}
            </div>
          </div>
        </div>
        {selectedLinearCustomView.url ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void window.api.shell.openUrl(selectedLinearCustomView.url!)}
            className="gap-1 border-border/50 bg-background/70"
          >
            <ExternalLink className="size-3.5" />
            {translate('auto.components.TaskPage.8675cd6188', 'Linear')}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto scrollbar-sleek">
        {linearCustomViewContentsError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {linearCustomViewContentsError}
          </div>
        ) : null}
        <LinearProjectTable
          projects={linearCustomViewProjectsResult.items}
          loading={linearCustomViewContentsLoading}
          hasError={!!linearCustomViewProjectsResult.errors?.length}
          workspaceSelection={selectedLinearWorkspaceId}
          onSelectProject={(project) =>
            openLinearProjectContext(project, { parentView: selectedLinearCustomView })
          }
          onOpenProject={(project) => {
            if (project.url) {
              void window.api.shell.openUrl(project.url)
            }
          }}
          onUseProjectIssues={(project) => {
            openLinearProjectContext(project, { parentView: selectedLinearCustomView })
            setLinearProjectTab('issues')
          }}
        />
      </div>
      <LinearCollectionNotice
        errors={linearCustomViewProjectsResult.errors}
        hasMore={linearCustomViewProjectsResult.hasMore}
        count={linearCustomViewProjectsResult.items.length}
        label={translate('auto.components.TaskPage.b39fe6511d', 'projects')}
      />
    </div>
  )
}
