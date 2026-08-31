import React from 'react'
import { LoaderCircle, Plus, RefreshCw, Search, X } from 'lucide-react'

import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import LinearIssueAttributeFilterDropdowns from '@/components/linear-issue-attribute-filter-dropdowns'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { LinearIssueAttributeFilter } from '../../../../../shared/linear/issue-attribute-filter'
import type { LinearProjectSummary } from '../../../../../shared/linear/project-types'
import type { LinearTeam } from '../../../../../shared/linear/workspace-types'
import type { TaskResumeState } from '../../../../../shared/ui-chrome-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { LinearMode } from '@/components/task-page-localized-options'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'

export type TaskPageLinearFiltersProps = {
  linearModeOptions: { id: LinearMode; label: string }[]
  linearMode: LinearMode
  selectLinearMode: (mode: LinearMode) => void
  selectedLinearProject: LinearProjectSummary | null
  availableTeams: LinearTeam[]
  setNewLinearProjectName: (value: string) => void
  setNewLinearProjectDescription: (value: string) => void
  setNewLinearProjectContent: (value: string) => void
  setNewLinearProjectTeamId: (id: string | null) => void
  setNewLinearProjectLeadId: (id: string | null) => void
  setNewLinearProjectMemberIds: (ids: string[]) => void
  setNewLinearProjectLabelIds: (ids: string[]) => void
  setNewLinearProjectPriority: (priority: number) => void
  setNewLinearProjectStartDate: (value: string) => void
  setNewLinearProjectTargetDate: (value: string) => void
  setNewLinearProjectOpen: (open: boolean) => void
  setNewLinearIssueTitle: (value: string) => void
  setNewLinearIssueBody: (value: string) => void
  setNewLinearIssueTeamId: (id: string | null) => void
  setNewLinearIssueProjectId: (id: string | null) => void
  setNewLinearIssueOpen: (open: boolean) => void
  setLinearRefreshNonce: React.Dispatch<React.SetStateAction<number>>
  linearLoading: boolean
  linearProjectsLoading: boolean
  linearProjectDetailLoading: boolean
  linearCustomViewsLoading: boolean
  linearCustomViewContentsLoading: boolean
  showLinearAttributeFilters: boolean
  linearAttributeFilter: LinearIssueAttributeFilter
  applyLinearAttributeFilter: (next: LinearIssueAttributeFilter) => void
  linearAttributeFilterWorkspaceId: string | null
  linearAttributePrimaryTeam: LinearTeam | null
  linearTeamSelection: ReadonlySet<string>
  linearTeamOptions: LinearTeam[]
  linearTaskSourceContext: TaskSourceContext | null
  settings: RuntimeLinearSettings | null
  linearSearchInput: string
  setLinearSearchInput: (value: string) => void
  setAppliedLinearSearch: (value: string) => void
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  linearProjectSearchInput: string
  setLinearProjectSearchInput: (value: string) => void
  setAppliedLinearProjectSearch: (value: string) => void
}

export function TaskPageLinearFilters(props: TaskPageLinearFiltersProps): React.JSX.Element {
  const {
    linearModeOptions,
    linearMode,
    selectLinearMode,
    selectedLinearProject,
    availableTeams,
    setNewLinearProjectName,
    setNewLinearProjectDescription,
    setNewLinearProjectContent,
    setNewLinearProjectTeamId,
    setNewLinearProjectLeadId,
    setNewLinearProjectMemberIds,
    setNewLinearProjectLabelIds,
    setNewLinearProjectPriority,
    setNewLinearProjectStartDate,
    setNewLinearProjectTargetDate,
    setNewLinearProjectOpen,
    setNewLinearIssueTitle,
    setNewLinearIssueBody,
    setNewLinearIssueTeamId,
    setNewLinearIssueProjectId,
    setNewLinearIssueOpen,
    setLinearRefreshNonce,
    linearLoading,
    linearProjectsLoading,
    linearProjectDetailLoading,
    linearCustomViewsLoading,
    linearCustomViewContentsLoading,
    showLinearAttributeFilters,
    linearAttributeFilter,
    applyLinearAttributeFilter,
    linearAttributeFilterWorkspaceId,
    linearAttributePrimaryTeam,
    linearTeamSelection,
    linearTeamOptions,
    linearTaskSourceContext,
    settings,
    linearSearchInput,
    setLinearSearchInput,
    setAppliedLinearSearch,
    setTaskResumeState,
    linearProjectSearchInput,
    setLinearProjectSearchInput,
    setAppliedLinearProjectSearch
  } = props

  return (
    <div
      className="min-w-0 rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 pt-2 pb-0 shadow-sm"
      data-contextual-tour-target="tasks-search-presets"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div
          className="flex items-center gap-1 text-xs"
          role="group"
          aria-label={translate('auto.components.TaskPage.0cbf7e5cf3', 'Linear task mode')}
        >
          {linearModeOptions.map((mode) => {
            const active = linearMode === mode.id
            const buttonClassName = cn(
              'rounded-md border px-2 py-1 text-xs transition',
              active
                ? 'border-border/50 bg-foreground/90 text-background'
                : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
            )
            if (mode.id === 'in-orca') {
              return (
                <Tooltip key={mode.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => selectLinearMode(mode.id)}
                      className={buttonClassName}
                    >
                      {mode.label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate(
                      'auto.components.TaskPage.linearModeHasWorktreeTooltip',
                      'Linear tickets linked to an Orca workspace'
                    )}
                  </TooltipContent>
                </Tooltip>
              )
            }
            return (
              <button
                key={mode.id}
                type="button"
                aria-pressed={active}
                onClick={() => selectLinearMode(mode.id)}
                className={buttonClassName}
              >
                {mode.label}
              </button>
            )
          })}
        </div>
        <div
          className="flex shrink-0 items-center gap-2"
          data-contextual-tour-target="tasks-actions"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  if (linearMode === 'projects' && !selectedLinearProject) {
                    // Why: restore dismissed typed text (accidental dismissal recoverable); pickers keep their fresh open-time defaults.
                    const draft = useAppStore.getState().newLinearProjectDraft
                    setNewLinearProjectName(draft?.name ?? '')
                    setNewLinearProjectDescription(draft?.description ?? '')
                    setNewLinearProjectContent(draft?.content ?? '')
                    setNewLinearProjectTeamId(availableTeams[0]?.id ?? null)
                    setNewLinearProjectLeadId(null)
                    setNewLinearProjectMemberIds([])
                    setNewLinearProjectLabelIds([])
                    setNewLinearProjectPriority(0)
                    setNewLinearProjectStartDate('')
                    setNewLinearProjectTargetDate('')
                    setNewLinearProjectOpen(true)
                    return
                  }
                  // Why: restore dismissed typed text (accidental dismissal recoverable); pickers keep their fresh open-time defaults.
                  const issueDraft = useAppStore.getState().newLinearIssueDraft
                  setNewLinearIssueTitle(issueDraft?.title ?? '')
                  setNewLinearIssueBody(issueDraft?.body ?? '')
                  const projectTeamId =
                    selectedLinearProject?.teams?.[0]?.id ??
                    availableTeams.find(
                      (team) => team.workspaceId === selectedLinearProject?.workspaceId
                    )?.id
                  setNewLinearIssueTeamId(projectTeamId ?? availableTeams[0]?.id ?? null)
                  setNewLinearIssueProjectId(selectedLinearProject?.id ?? null)
                  setNewLinearIssueOpen(true)
                }}
                disabled={availableTeams.length === 0}
                aria-label={
                  linearMode === 'projects' && !selectedLinearProject
                    ? translate('auto.components.TaskPage.1361275ec3', 'New Linear project')
                    : translate('auto.components.TaskPage.3feb524d42', 'New Linear issue')
                }
                className="size-8 border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {linearMode === 'projects' && !selectedLinearProject
                ? translate('auto.components.TaskPage.1361275ec3', 'New Linear project')
                : translate('auto.components.TaskPage.3feb524d42', 'New Linear issue')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setLinearRefreshNonce((n) => n + 1)}
                disabled={
                  linearMode === 'issues' || linearMode === 'in-orca'
                    ? linearLoading
                    : linearMode === 'projects'
                      ? linearProjectsLoading || linearProjectDetailLoading
                      : linearCustomViewsLoading || linearCustomViewContentsLoading
                }
                aria-label={translate('auto.components.TaskPage.8964184a8b', 'Refresh Linear')}
                className="size-8 border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
              >
                {(linearMode === 'issues' || linearMode === 'in-orca') && linearLoading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : linearMode === 'projects' &&
                  (linearProjectsLoading || linearProjectDetailLoading) ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : linearMode === 'views' &&
                  (linearCustomViewsLoading || linearCustomViewContentsLoading) ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.8964184a8b', 'Refresh Linear')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {linearMode === 'issues' || linearMode === 'in-orca' ? (
        <div className="mt-3 flex min-w-0 items-center gap-2">
          {showLinearAttributeFilters ? (
            <LinearIssueAttributeFilterDropdowns
              value={linearAttributeFilter}
              onChange={applyLinearAttributeFilter}
              workspaceId={linearAttributeFilterWorkspaceId}
              primaryTeam={linearAttributePrimaryTeam}
              selectedTeamIds={[...linearTeamSelection]}
              availableTeams={linearTeamOptions}
              teamsSettled={availableTeams.length > 0}
              settings={linearTaskSourceContext ?? settings}
            />
          ) : null}
          <div className="relative min-w-0 flex-1 basis-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={linearSearchInput}
              onChange={(e) => setLinearSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (
                    shouldSuppressEnterSubmit(
                      { isComposing: e.nativeEvent.isComposing, shiftKey: e.shiftKey },
                      false
                    )
                  ) {
                    return
                  }
                  e.preventDefault()
                  const trimmed = linearSearchInput.trim()
                  setLinearSearchInput(trimmed)
                  setAppliedLinearSearch(trimmed)
                  setTaskResumeState({
                    linearQuery: trimmed,
                    linearMode: linearMode === 'in-orca' ? 'in-orca' : 'issues'
                  })
                  if (linearMode !== 'in-orca') {
                    setLinearRefreshNonce((n) => n + 1)
                  }
                }
              }}
              placeholder={
                linearMode === 'in-orca'
                  ? translate(
                      'auto.components.TaskPage.linearHasWorktreeSearchPlaceholder',
                      'Filter issues linked to an Orca workspace...'
                    )
                  : translate('auto.components.TaskPage.eec0c5c079', 'Search Linear issues...')
              }
              className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
            />
            {linearSearchInput ? (
              <button
                type="button"
                aria-label={translate('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
                onClick={() => {
                  setLinearSearchInput('')
                  setAppliedLinearSearch('')
                  setTaskResumeState({
                    linearQuery: '',
                    linearMode: linearMode === 'in-orca' ? 'in-orca' : 'issues'
                  })
                  if (linearMode !== 'in-orca') {
                    setLinearRefreshNonce((n) => n + 1)
                  }
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        </div>
      ) : linearMode === 'projects' && !selectedLinearProject ? (
        <div className="mt-3 flex min-w-0 items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={linearProjectSearchInput}
              onChange={(e) => setLinearProjectSearchInput(e.target.value)}
              placeholder={translate(
                'auto.components.TaskPage.0b65d3fb2c',
                'Search Linear projects...'
              )}
              className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
            />
            {linearProjectSearchInput ? (
              <button
                type="button"
                aria-label={translate('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
                onClick={() => {
                  setLinearProjectSearchInput('')
                  setAppliedLinearProjectSearch('')
                  setLinearRefreshNonce((n) => n + 1)
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
