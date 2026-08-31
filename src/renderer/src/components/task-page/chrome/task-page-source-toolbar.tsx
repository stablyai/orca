import React from 'react'
import { AlertCircle, ExternalLink, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LinearScopeSelector } from '@/components/linear-scope-selector'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { JiraIssue, JiraSite } from '../../../../../shared/jira-types'
import type {
  LinearTeam,
  LinearWorkspace,
  LinearWorkspaceSelection
} from '../../../../../shared/linear/workspace-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { SourceOption } from '@/components/task-page-localized-options'
import type { TaskPageJiraLoadError } from '@/components/task-page-jira-load-state'
import type {
  TaskSourceAvailabilityNotice,
  TaskSourceContextSummary
} from '@/components/task-source-context-summary'

export type TaskPageSourceToolbarProps = {
  closeTaskPage: () => void
  visibleSourceOptions: SourceOption[]
  taskSource: TaskProvider
  taskSourceAvailabilityNoticeByProvider: Partial<
    Record<TaskProvider, TaskSourceAvailabilityNotice>
  >
  taskSourceManuallyChangedRef: React.MutableRefObject<boolean>
  openTaskPage: (
    data?: { taskSource?: TaskProvider },
    options?: { recordTasksInteraction?: boolean }
  ) => void
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  taskSourceContextSummary: TaskSourceContextSummary
  linearConnected: boolean
  linearWorkspaces: LinearWorkspace[]
  selectedLinearWorkspaceId: LinearWorkspaceSelection | null
  linearTeamOptions: LinearTeam[]
  linearTeamSelection: ReadonlySet<string>
  defaultLinearTeamSelection: string[] | null | undefined
  onLinearWorkspaceChange: (workspaceId: LinearWorkspaceSelection) => void
  onLinearTeamSelectionChange: (next: ReadonlySet<string>, persisted: string[] | null) => void
  onOpenLinearConnect: () => void
  onLinearScopeOpen: () => void
  selectedLinearTeamForExternalLink: LinearTeam | null
  jiraConnected: boolean
  jiraSites: JiraSite[]
  selectedJiraSiteId: string | null
  selectJiraSite: (siteId: string) => Promise<void>
  setSelectedJiraIssueKey: (key: string | null) => void
  setSelectedJiraIssueFallback: (issue: JiraIssue | null) => void
  setJiraIssues: (issues: JiraIssue[]) => void
  setJiraError: (error: TaskPageJiraLoadError | null) => void
  setJiraLoading: (loading: boolean) => void
  taskSourceAvailabilityNotice: TaskSourceAvailabilityNotice | null
}

export function TaskPageSourceToolbar({
  closeTaskPage,
  visibleSourceOptions,
  taskSource,
  taskSourceAvailabilityNoticeByProvider,
  taskSourceManuallyChangedRef,
  openTaskPage,
  updateSettings,
  taskSourceContextSummary,
  linearConnected,
  linearWorkspaces,
  selectedLinearWorkspaceId,
  linearTeamOptions,
  linearTeamSelection,
  defaultLinearTeamSelection,
  onLinearWorkspaceChange,
  onLinearTeamSelectionChange,
  onOpenLinearConnect,
  onLinearScopeOpen,
  selectedLinearTeamForExternalLink,
  jiraConnected,
  jiraSites,
  selectedJiraSiteId,
  selectJiraSite,
  setSelectedJiraIssueKey,
  setSelectedJiraIssueFallback,
  setJiraIssues,
  setJiraError,
  setJiraLoading,
  taskSourceAvailabilityNotice
}: TaskPageSourceToolbarProps): React.JSX.Element {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div
          className="flex min-w-0 flex-wrap items-center gap-2"
          data-contextual-tour-target="tasks-source-filters"
        >
          {/* Why: Close is anchored left with the source icons for one compact band, clear of the app sidebar on the right. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-full"
                onClick={closeTaskPage}
                aria-label={translate('auto.components.TaskPage.1a06219d5c', 'Close tasks')}
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.4826fd1ad8', 'Close · Esc')}
            </TooltipContent>
          </Tooltip>
          <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
          {visibleSourceOptions.map((source) => {
            const active = taskSource === source.id
            const sourceAvailabilityNotice =
              taskSourceAvailabilityNoticeByProvider[source.id] ?? null
            const sourceDisabled = source.disabled || sourceAvailabilityNotice?.blocking
            return (
              <Tooltip key={source.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={sourceDisabled}
                    onClick={() => {
                      if (sourceAvailabilityNotice?.blocking) {
                        return
                      }
                      taskSourceManuallyChangedRef.current = true
                      openTaskPage({ taskSource: source.id }, { recordTasksInteraction: false })
                      void updateSettings({ defaultTaskSource: source.id }).catch(() => {
                        toast.error(
                          translate(
                            'auto.components.TaskPage.609532fae7',
                            'Failed to save default task source.'
                          )
                        )
                      })
                    }}
                    data-task-source={source.id}
                    aria-label={sourceAvailabilityNotice?.label ?? source.label}
                    aria-pressed={active}
                    className={cn(
                      'group flex h-8 w-8 items-center justify-center rounded-md border transition',
                      active
                        ? 'border-foreground/40 bg-muted/70 text-foreground shadow-sm'
                        : 'border-border/40 bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                      sourceDisabled && 'cursor-not-allowed opacity-55'
                    )}
                  >
                    <source.Icon className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {sourceAvailabilityNotice?.label ?? source.label}
                </TooltipContent>
              </Tooltip>
            )
          })}
          <div
            className="hidden min-w-0 max-w-[min(420px,40vw)] items-center rounded-md border border-border/50 bg-muted/35 px-2 py-1 text-xs text-muted-foreground sm:flex"
            title={taskSourceContextSummary.title}
          >
            <span className="truncate">{taskSourceContextSummary.label}</span>
          </div>
        </div>
        {taskSource === 'linear' && linearConnected ? (
          <div className="flex items-center gap-2">
            <LinearScopeSelector
              workspaces={linearWorkspaces}
              selectedWorkspaceId={selectedLinearWorkspaceId}
              teams={linearTeamOptions}
              selectedTeamIds={linearTeamSelection}
              teamSelectionIsStickyAll={defaultLinearTeamSelection == null}
              onWorkspaceChange={onLinearWorkspaceChange}
              onTeamSelectionChange={onLinearTeamSelectionChange}
              onAddTeamAccess={onOpenLinearConnect}
              onOpen={onLinearScopeOpen}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={() => {
                    if (!selectedLinearTeamForExternalLink?.url) {
                      return
                    }
                    void window.api.shell.openUrl(selectedLinearTeamForExternalLink.url)
                  }}
                  disabled={!selectedLinearTeamForExternalLink}
                  aria-label={
                    selectedLinearTeamForExternalLink
                      ? translate(
                          'auto.components.TaskPage.246bd64aed',
                          'Open {{value0}} in Linear',
                          { value0: selectedLinearTeamForExternalLink.name }
                        )
                      : translate(
                          'auto.components.TaskPage.8029e2bd4d',
                          'Select one Linear team to open in Linear'
                        )
                  }
                  className="h-8 w-8 rounded-md border-border/50 bg-muted/50 text-foreground shadow-sm transition hover:bg-muted/50"
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {selectedLinearTeamForExternalLink
                  ? translate('auto.components.TaskPage.246bd64aed', 'Open {{value0}} in Linear', {
                      value0: selectedLinearTeamForExternalLink.name
                    })
                  : translate(
                      'auto.components.TaskPage.2af3ab5c58',
                      'Select one team to open in Linear'
                    )}
              </TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {taskSource === 'jira' && jiraConnected ? (
          <div className="flex items-center gap-2">
            {jiraSites.length > 1 ? (
              <Select
                value={selectedJiraSiteId ?? undefined}
                onValueChange={(value) => {
                  setSelectedJiraIssueKey(null)
                  setSelectedJiraIssueFallback(null)
                  setJiraIssues([])
                  setJiraError(null)
                  setJiraLoading(true)
                  void selectJiraSite(value).catch(() => {
                    toast.error(
                      translate(
                        'auto.components.TaskPage.d09b7631b7',
                        'Failed to switch Jira site.'
                      )
                    )
                  })
                }}
              >
                <SelectTrigger className="h-8 w-[220px] rounded-md border-border/50 bg-muted/50 text-xs font-medium shadow-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {translate('auto.components.TaskPage.e592d99051', 'All Jira sites')}
                  </SelectItem>
                  {jiraSites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        ) : null}
      </div>

      {taskSourceAvailabilityNotice ? (
        <div
          role="status"
          className="flex max-w-3xl items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          title={taskSourceAvailabilityNotice.title}
        >
          <AlertCircle className="size-3.5 flex-none" />
          <span className="min-w-0 truncate">{taskSourceAvailabilityNotice.label}</span>
        </div>
      ) : null}
    </>
  )
}
