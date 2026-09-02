import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
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

export function isAllTaskProjectsSelected(
  groups: readonly TaskProjectPickerGroup[],
  selected: ReadonlySet<string>
): boolean {
  return groups.length > 0 && selectedTaskProjectGroups(groups, selected).length === groups.length
}

/**
 * Toggle a project group in the Tasks project selector.
 * Returns null when the click is a no-op (cannot deselect the last project).
 *
 * Why: when every project is selected ("All projects"), clicking one project
 * must mean "only this project" — the old toggle treated it as exclude, which
 * is not discoverable (#10182).
 */
export function nextTaskProjectSelectionAfterToggle(args: {
  groups: readonly TaskProjectPickerGroup[]
  selected: ReadonlySet<string>
  group: TaskProjectPickerGroup
}): Set<string> | null {
  if (isAllTaskProjectsSelected(args.groups, args.selected)) {
    // Keep the host the user actually had selected, not just the group primary.
    return new Set([getSelectedTaskProjectSource(args.group, args.selected).id])
  }

  const next = new Set(args.selected)
  if (isTaskProjectGroupSelected(args.group, next)) {
    if (selectedTaskProjectGroups(args.groups, args.selected).length <= 1) {
      return null
    }
    for (const source of args.group.sources) {
      next.delete(source.id)
    }
    return next
  }
  next.add(args.group.repo.id)
  return next
}
