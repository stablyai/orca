import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import TaskProjectSourceCombobox from '@/components/task-page/source-selection/task-project-source-combobox'
import { normalizeTaskRepoSelection } from '../../../../../shared/work-items/task-repo-selection'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'

/** Project picker for repo-backed task sources; saves the selection as the default. */
export function TaskRepoSourcePicker({
  model
}: {
  model: Pick<
    TaskPageComposerActionsModel,
    | 'updateSettings'
    | 'eligibleRepos'
    | 'repoSelection'
    | 'setRepoSelection'
    | 'taskPickerGroups'
    | 'taskPickerRepos'
    | 'getTaskPickerRepoHostLabel'
  >
}): React.JSX.Element {
  const t = useTranslate()
  const {
    updateSettings,
    eligibleRepos,
    repoSelection,
    setRepoSelection,
    taskPickerGroups,
    taskPickerRepos,
    getTaskPickerRepoHostLabel
  } = model
  const saveSelection = (selection: string[] | null): void => {
    void updateSettings({ defaultRepoSelection: selection }).catch(() => {
      toast.error(t('auto.components.TaskPage.dfd72673e7', 'Failed to save project selection.'))
    })
  }
  return (
    <TaskProjectSourceCombobox
      groups={taskPickerGroups}
      selected={repoSelection}
      getRepoHostLabel={getTaskPickerRepoHostLabel}
      onChange={(next) => {
        const normalized = normalizeTaskRepoSelection(eligibleRepos, next)
        setRepoSelection(normalized)
        saveSelection([...normalized])
      }}
      onSelectAll={() => {
        setRepoSelection(new Set(taskPickerRepos.map((r) => r.id)))
        saveSelection(null)
      }}
      triggerClassName="h-8 w-full rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
    />
  )
}
