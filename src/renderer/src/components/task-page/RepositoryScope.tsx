import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import TaskProjectSourceCombobox from '@/components/task-page/source-selection/task-project-source-combobox'
import { normalizeTaskRepoSelection } from '../../../../shared/work-items/task-repo-selection'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { ExternalLink } from 'lucide-react'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
type Props = { model: TaskPageComposerActionsModel }

export function TaskPageRepositoryScope({ model }: Props): React.JSX.Element {
  const t = useTranslate()
  const {
    updateSettings,
    eligibleRepos,
    repoSelection,
    setRepoSelection,
    taskPickerGroups,
    taskPickerRepos,
    getTaskPickerRepoHostLabel,
    selectedGitHubRepoExternalLink,
    taskSource,
    taskSourceContextSummary
  } = model
  return (
    <>
      {/* Repository-backed Project rows follow this selection in both GitHub modes. */}
      <div className="min-w-0 max-w-[220px] shrink" title={taskSourceContextSummary.title}>
        <TaskProjectSourceCombobox
          groups={taskPickerGroups}
          selected={repoSelection}
          getRepoHostLabel={getTaskPickerRepoHostLabel}
          onChange={(next) => {
            const normalized = normalizeTaskRepoSelection(eligibleRepos, next)
            setRepoSelection(normalized)
            void updateSettings({
              defaultRepoSelection: [...normalized]
            }).catch(() => {
              toast.error(
                t('auto.components.TaskPage.dfd72673e7', 'Failed to save project selection.')
              )
            })
          }}
          onSelectAll={() => {
            const allIds = new Set(taskPickerRepos.map((r) => r.id))
            setRepoSelection(allIds)
            void updateSettings({
              defaultRepoSelection: null
            }).catch(() => {
              toast.error(
                t('auto.components.TaskPage.dfd72673e7', 'Failed to save project selection.')
              )
            })
          }}
          triggerClassName="h-7"
        />
      </div>
      {taskSource === 'github' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-toolbar"
              onClick={(event) => {
                if (!selectedGitHubRepoExternalLink?.url) {
                  return
                }
                openAppHttpLink(selectedGitHubRepoExternalLink.url, { event })
              }}
              aria-label={
                selectedGitHubRepoExternalLink
                  ? t('auto.components.TaskPage.8d1e17a3ef', 'Open {{value0}} in GitHub', {
                      value0: selectedGitHubRepoExternalLink.label
                    })
                  : t(
                      'auto.components.TaskPage.d1132848f8',
                      'Select one GitHub project to open in GitHub'
                    )
              }
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {selectedGitHubRepoExternalLink
              ? t('auto.components.TaskPage.8d1e17a3ef', 'Open {{value0}} in GitHub', {
                  value0: selectedGitHubRepoExternalLink.label
                })
              : t('auto.components.TaskPage.bc46d8204e', 'Select one project to open in GitHub')}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}
