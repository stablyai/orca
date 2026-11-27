import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/class-names'
import { LinearScopeSelector } from '@/components/task-page/source-selection/linear-scope-selector'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
export function TaskPageSourceBar({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const {
    openTaskPage,
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
    taskSourceContextSummary,
    taskSourceAvailabilityNoticeByProvider,
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
    <>
      <div
        className="flex shrink-0 items-center rounded-md border border-border p-0.5"
        data-contextual-tour-target="tasks-source-filters"
      >
        {visibleSourceOptions.map((source) => {
          const active = taskSource === source.id
          const sourceAvailabilityNotice = taskSourceAvailabilityNoticeByProvider[source.id] ?? null
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
                    openTaskPage(
                      {
                        taskSource: source.id
                      },
                      {
                        recordTasksInteraction: false
                      }
                    )
                    void updateSettings({
                      defaultTaskSource: source.id
                    }).catch(() => {
                      toast.error(
                        t(
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
                    'flex size-6 items-center justify-center rounded-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
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
      </div>
      {taskSource === 'linear' && linearConnected ? (
        <div className="flex min-w-0 items-center gap-1.5" title={taskSourceContextSummary.title}>
          <LinearScopeSelector
            className="h-7 min-w-0 shrink"
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
                variant="ghost"
                size="icon-toolbar"
                onClick={(event) => {
                  if (!selectedLinearTeamForExternalLink?.url) {
                    return
                  }
                  openAppHttpLink(selectedLinearTeamForExternalLink.url, { event })
                }}
                disabled={!selectedLinearTeamForExternalLink}
                aria-label={
                  selectedLinearTeamForExternalLink
                    ? t('auto.components.TaskPage.246bd64aed', 'Open {{value0}} in Linear', {
                        value0: selectedLinearTeamForExternalLink.name
                      })
                    : t(
                        'auto.components.TaskPage.8029e2bd4d',
                        'Select one Linear team to open in Linear'
                      )
                }
              >
                <ExternalLink className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {selectedLinearTeamForExternalLink
                ? t('auto.components.TaskPage.246bd64aed', 'Open {{value0}} in Linear', {
                    value0: selectedLinearTeamForExternalLink.name
                  })
                : t('auto.components.TaskPage.2af3ab5c58', 'Select one team to open in Linear')}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {taskSource === 'jira' && jiraConnected ? (
        <div className="flex min-w-0 items-center gap-1.5" title={taskSourceContextSummary.title}>
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
                    t('auto.components.TaskPage.d09b7631b7', 'Failed to switch Jira site.')
                  )
                })
              }}
            >
              <SelectTrigger size="xs" className="max-w-55 min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t('auto.components.TaskPage.e592d99051', 'All Jira sites')}
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
    </>
  )
}
