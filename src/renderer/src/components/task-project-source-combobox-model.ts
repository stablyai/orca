import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/types'
import type { TaskProjectPickerGroup } from './task-page-default-repo-selection'

export function selectedTaskProjectGroups(
  groups: readonly TaskProjectPickerGroup[],
  selected: ReadonlySet<string>
): TaskProjectPickerGroup[] {
  return groups.filter((group) => group.sources.some((source) => selected.has(source.id)))
}

export function isTaskProjectGroupSelected(
  group: TaskProjectPickerGroup,
  selected: ReadonlySet<string>
): boolean {
  return group.sources.some((source) => selected.has(source.id))
}

export function getSelectedTaskProjectSource(
  group: TaskProjectPickerGroup,
  selected: ReadonlySet<string>
): Repo {
  return group.sources.find((source) => selected.has(source.id)) ?? group.repo
}

export function hasMultipleTaskProjectHosts(groups: readonly TaskProjectPickerGroup[]): boolean {
  const hostIds = new Set<string>()
  for (const group of groups) {
    for (const source of group.sources) {
      hostIds.add(getRepoExecutionHostId(source))
      if (hostIds.size > 1) {
        return true
      }
    }
  }
  return false
}

export function hasMultipleTaskProjectHostsInGroup(group: TaskProjectPickerGroup): boolean {
  return hasMultipleTaskProjectHosts([group])
}
