import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { RefreshCw, Sparkles, Square } from 'lucide-react'

/** Title input of the new-issue dialog with the AI generate-from-description action. */
export function TaskPageJiraIssueTitleField({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const {
    newJiraIssueTitle,
    setNewJiraIssueTitle,
    newJiraIssueBody,
    newJiraIssueSubmitting,
    newJiraIssueSummaryGenerating,
    handleGenerateNewJiraIssueSummary,
    handleCancelNewJiraIssueSummaryGeneration,
    handleCreateNewJiraIssue
  } = model
  const generateDisabled = !newJiraIssueBody.trim() || newJiraIssueSubmitting
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.TaskPage.16cba35bee', 'Title')}
      </label>
      {/* Why: the action sits beside the Input — the primitive owns its spacing, so no inner padding restyle. */}
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          value={newJiraIssueTitle}
          onChange={(e) => setNewJiraIssueTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void handleCreateNewJiraIssue()
            }
          }}
          placeholder={translate('auto.components.TaskPage.578f730c16', 'Short summary')}
          disabled={newJiraIssueSubmitting}
        />
        {newJiraIssueSummaryGenerating ? (
          // Why: while generating, the icon doubles as cancel — hover/focus swaps the spinner to a destructive Square via CSS group toggles (stateless in React).
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => handleCancelNewJiraIssueSummaryGeneration()}
                aria-label={translate(
                  'auto.components.task.page.jira.IssueDialog.5d4c813e3f',
                  'Stop generating title'
                )}
                className="group inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/40"
              >
                <RefreshCw className="size-3.5 animate-spin group-hover:hidden group-focus-visible:hidden" />
                <Square className="hidden size-3.5 fill-current group-hover:block group-focus-visible:block" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={6}>
              {translate(
                'auto.components.task.page.jira.IssueDialog.7a9b8eb34a',
                'Generating title. Click to stop.'
              )}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-disabled={generateDisabled}
                onClick={(event) => {
                  if (generateDisabled) {
                    event.preventDefault()
                    return
                  }
                  void handleGenerateNewJiraIssueSummary()
                }}
                aria-label={translate(
                  'auto.components.task.page.jira.IssueDialog.1dc54e5fa9',
                  'Generate title from description'
                )}
                className={cn(
                  'inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  generateDisabled &&
                    'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground'
                )}
              >
                <Sparkles className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={6}>
              {translate(
                'auto.components.task.page.jira.IssueDialog.1dc54e5fa9',
                'Generate title from description'
              )}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
