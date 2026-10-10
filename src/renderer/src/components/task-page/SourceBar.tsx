import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { X, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { LinearScopeSelector } from '@/components/linear-scope-selector'
import { TaskPageSourceIconButton } from './SourceIconButton'
import { TaskPagePluginSourceButtons } from './plugin/PluginSourceButtons'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
export function TaskPageSourceBar({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    openTaskPage,
    closeTaskPage,
    updateSettings,
    selectJiraSite,
    linearConnected,
    jiraConnected,
    linearWorkspaces,
    selectedLinearWorkspaceId,
    jiraSites,
    selectedJiraSiteId,
    visibleSourceOptions,
    taskSource,
    taskSourceAvailabilityNoticeByProvider,
    taskSourceContextSummary,
    taskSourceManuallyChangedRef,
    setSelectedJiraIssueKey,
    setSelectedJiraIssueFallback,
    setJiraIssues,
    setJiraLoading,
    setJiraError,
    defaultLinearTeamSelection,
    linearTeamSelection,
    linearTeamOptions,
    selectedLinearTeamForExternalLink,
    setLinearConnectOpen,
    handleLinearWorkspaceChange,
    handleLinearTeamSelectionChange,
    handleLinearScopeOpen
  } = model
  return (
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
          const sourceAvailabilityNotice = taskSourceAvailabilityNoticeByProvider[source.id] ?? null
          return (
            <TaskPageSourceIconButton
              key={source.id}
              label={sourceAvailabilityNotice?.label ?? source.label}
              active={taskSource === source.id}
              disabled={Boolean(source.disabled || sourceAvailabilityNotice?.blocking)}
              dataTaskSource={source.id}
              onSelect={() => {
                if (sourceAvailabilityNotice?.blocking) {
                  return
                }
                taskSourceManuallyChangedRef.current = true
                openTaskPage(
                  {
                    taskSource: source.id
                  },
                  {
                    recordTasksInteraction: false
                  }
                )
                void updateSettings({
                  defaultTaskSource: source.id,
                  defaultPluginTaskSource: null
                }).catch(() => {
                  toast.error(
                    translate(
                      'auto.components.TaskPage.609532fae7',
                      'Failed to save default task source.'
                    )
                  )
                })
              }}
            >
              <source.Icon className="size-3.5" />
            </TaskPageSourceIconButton>
          )
        })}
        <TaskPagePluginSourceButtons activeKey={null} />
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
            onWorkspaceChange={handleLinearWorkspaceChange}
            onTeamSelectionChange={handleLinearTeamSelectionChange}
            onAddTeamAccess={() => setLinearConnectOpen(true)}
            onOpen={handleLinearScopeOpen}
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
                        {
                          value0: selectedLinearTeamForExternalLink.name
                        }
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
                    translate('auto.components.TaskPage.d09b7631b7', 'Failed to switch Jira site.')
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
  )
}
