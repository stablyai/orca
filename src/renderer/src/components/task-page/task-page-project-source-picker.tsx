import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import TaskProjectSourceCombobox from '@/components/task-project-source-combobox'
import { normalizeTaskRepoSelection } from '@/components/task-page/task-page-default-repo-selection'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
export function TaskPageProjectSourcePicker({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const {
    updateSettings,
    eligibleRepos,
    repoSelection,
    setRepoSelection,
    taskPickerGroups,
    taskPickerRepos,
    getTaskPickerRepoHostLabel
  } = model
  return (
    <div className="min-w-0 w-full sm:w-[200px]">
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
              translate('auto.components.TaskPage.dfd72673e7', 'Failed to save project selection.')
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
              translate('auto.components.TaskPage.dfd72673e7', 'Failed to save project selection.')
            )
          })
        }}
        triggerClassName="h-8 w-full rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
      />
    </div>
  )
}
