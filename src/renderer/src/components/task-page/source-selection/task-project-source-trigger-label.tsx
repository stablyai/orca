import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { useTranslate } from '@/i18n/use-translate'
import type { TaskProjectPickerGroup } from '../../../../../shared/work-items/task-repo-selection'
import { selectedTaskProjectGroups } from './task-project-source-combobox-model'

export function TaskProjectSourceTriggerLabel({
  groups,
  selected
}: {
  groups: readonly TaskProjectPickerGroup[]
  selected: ReadonlySet<string>
}): React.JSX.Element {
  const t = useTranslate()
  if (groups.length === 0) {
    return (
      <span className="text-muted-foreground">
        {t('auto.components.task.project.source.combobox.noProjects', 'No projects')}
      </span>
    )
  }
  const selectedProjectGroups = selectedTaskProjectGroups(groups, selected)
  if (selectedProjectGroups.length === groups.length) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {t('auto.components.task.project.source.combobox.allProjects', 'All projects')}
      </span>
    )
  }
  const [first, second, ...rest] = selectedProjectGroups
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
      {first ? (
        <RepoBadgeLabel
          name={first.repo.displayName}
          color={first.repo.badgeColor}
          repo={first.repo}
        />
      ) : null}
      {second ? <span className="text-muted-foreground">, {second.repo.displayName}</span> : null}
      {rest.length > 0 ? <span className="text-muted-foreground">+{rest.length}</span> : null}
    </span>
  )
}
