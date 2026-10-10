import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Loader2, Sparkles, Square } from 'lucide-react'

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
    newJiraIssueSummaryAvailable,
    handleGenerateNewJiraIssueSummary,
    handleCancelNewJiraIssueSummaryGeneration,
    handleCreateNewJiraIssue
  } = model
  const generateDisabled = !newJiraIssueBody.trim() || newJiraIssueSubmitting
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor="new-jira-issue-title"
        className="text-[11px] font-medium text-muted-foreground"
      >
        {translate('auto.components.TaskPage.16cba35bee', 'Title')}
      </label>
      <div className="flex items-center gap-1">
        <Input
          id="new-jira-issue-title"
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
        {!newJiraIssueSummaryAvailable ? null : newJiraIssueSummaryGenerating ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleCancelNewJiraIssueSummaryGeneration()}
                aria-label={translate(
                  'components.jiraIssueTitleField.stop',
                  'Stop generating title'
                )}
                className="group"
              >
                <Loader2 className="size-3.5 animate-spin group-hover:hidden group-focus-visible:hidden" />
                <Square className="hidden size-3.5 fill-current group-hover:block group-focus-visible:block" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate(
                'components.jiraIssueTitleField.generating',
                'Generating title. Click to stop.'
              )}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={generateDisabled}
                onClick={() => void handleGenerateNewJiraIssueSummary()}
                aria-label={translate(
                  'components.jiraIssueTitleField.generate',
                  'Generate title from description'
                )}
              >
                <Sparkles className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate(
                'components.jiraIssueTitleField.generate',
                'Generate title from description'
              )}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
