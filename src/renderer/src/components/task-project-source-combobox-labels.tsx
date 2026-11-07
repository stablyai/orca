import React from 'react'
import type { Repo } from '../../../shared/repo-types'
import type { TaskProjectPickerGroup } from './task-page/task-page-default-repo-selection'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { translate } from '@/i18n/i18n'
import { projectHostCountLabel } from './project-host-count-label'
import {
  selectedTaskProjectGroups,
  getSelectedTaskProjectSource,
  getRepoSourceHostCount
} from './task-project-source-combobox-model'

export type TaskProjectSourceStatus = {
  label: string
  title?: string
  disabled?: boolean
}

export function renderTriggerLabel(
  groups: readonly TaskProjectPickerGroup[],
  selected: ReadonlySet<string>
): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <span className="text-muted-foreground">
        {translate('auto.components.task.project.source.combobox.noProjects', 'No projects')}
      </span>
    )
  }
  const selectedProjectGroups = selectedTaskProjectGroups(groups, selected)
  if (selectedProjectGroups.length === groups.length) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {translate('auto.components.task.project.source.combobox.allProjects', 'All projects')}
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
          badgeClassName="size-1.5"
        />
      ) : null}
      {second ? <span className="text-muted-foreground">, {second.repo.displayName}</span> : null}
      {rest.length > 0 ? <span className="text-muted-foreground">+{rest.length}</span> : null}
    </span>
  )
}

export function getProjectDetail(
  group: TaskProjectPickerGroup,
  selected: ReadonlySet<string>,
  showHostLabels: boolean,
  getRepoHostLabel?: (repo: Repo) => string | null | undefined,
  sourceHostCount = getRepoSourceHostCount(group.sources)
): string {
  const selectedSource = getSelectedTaskProjectSource(group, selected)
  if (!selectedSource) {
    return translate('projects.unavailableSource', 'Unavailable')
  }
  const hostLabel = showHostLabels ? getRepoHostLabel?.(selectedSource)?.trim() : ''
  if (sourceHostCount > 1) {
    const hostCount = projectHostCountLabel(sourceHostCount)
    return hostLabel ? `${hostLabel} · ${hostCount}` : hostCount
  }
  return hostLabel ? `${hostLabel} · ${selectedSource.path}` : selectedSource.path
}

export function getSourceDetail(repo: Repo, status?: TaskProjectSourceStatus | null): string {
  return status?.label ? `${repo.path} · ${status.label}` : repo.path
}
