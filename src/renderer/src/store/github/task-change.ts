import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'

/** One edit's own semantic change: set title or state, add or remove named members (logins lower-cased). */
export type TaskChange = {
  title?: string
  state?: GitHubWorkItem['state']
  labels?: Readonly<Record<string, boolean>>
  assignees?: Readonly<Record<string, GitHubAssignableUser | null>>
}
export type TaskFacts = Pick<GitHubWorkItem, 'title' | 'state' | 'labels' | 'assignees'>
type TaskSources = readonly (TaskSourceContext | null | undefined)[]
const login = (value: string) => value.toLowerCase()

export function isEmptyTaskChange(change: TaskChange): boolean {
  return (
    change.title === undefined &&
    change.state === undefined &&
    !Object.keys(change.labels ?? {}).length &&
    !Object.keys(change.assignees ?? {}).length
  )
}
/** Applies only the change's own fields and members; a copy that doesn't know its assignees keeps them unknown. */
export function applyTaskChange<T extends TaskFacts>(item: T, change: TaskChange | undefined): T {
  if (!change) {
    return item
  }
  let labels = item.labels
  for (const [name, present] of Object.entries(change.labels ?? {})) {
    if (labels.includes(name) !== present) {
      labels = present ? [...labels, name] : labels.filter((value) => value !== name)
    }
  }
  let assignees = item.assignees
  for (const [key, user] of Object.entries(change.assignees ?? {})) {
    if (assignees && assignees.some((value) => login(value.login) === key) !== !!user) {
      assignees = user
        ? [...assignees, user]
        : assignees.filter((value) => login(value.login) !== key)
    }
  }
  return {
    ...item,
    ...(change.title === undefined ? {} : { title: change.title }),
    ...(change.state === undefined ? {} : { state: change.state }),
    labels,
    ...(assignees === undefined ? {} : { assignees })
  }
}
/** Coalesces a later change over an earlier one: the last set or membership edit per field/member wins. */
export function composeTaskChanges(earlier: TaskChange | undefined, later: TaskChange): TaskChange {
  return {
    title: later.title ?? earlier?.title,
    state: later.state ?? earlier?.state,
    labels: { ...earlier?.labels, ...later.labels },
    assignees: { ...earlier?.assignees, ...later.assignees }
  }
}
/** Returns the fields and members `change` touches to how they read in `value`, skipping those already there. */
export function revertTaskChange(change: TaskChange, value: TaskFacts): TaskChange {
  const users = value.assignees
  return {
    ...(change.title === undefined || change.title === value.title ? {} : { title: value.title }),
    ...(change.state === undefined || change.state === value.state ? {} : { state: value.state }),
    labels: Object.fromEntries(
      Object.entries(change.labels ?? {})
        .filter(([name, present]) => value.labels.includes(name) !== present)
        .map(([name, present]): [string, boolean] => [name, !present])
    ),
    assignees: Object.fromEntries(
      Object.entries(change.assignees ?? {}).flatMap(
        ([key, user]): [string, GitHubAssignableUser | null][] => {
          const had = users?.find((entry) => login(entry.login) === key)
          return !users || !had === !user ? [] : [[key, had ?? null]]
        }
      )
    )
  }
}
/** Applies a change to each matching copy's current value, leaving its unrelated facts and members alone. */
export function publishTaskChange(
  store: Pick<StoreApi<AppState>, 'getState'>,
  item: GitHubWorkItem,
  change: TaskChange,
  sources: TaskSources
) {
  if (isEmptyTaskChange(change)) {
    return
  }
  const ownerRepo = parseGitHubIssueOrPRLink(item.url)?.slug
  const patch = (row: GitHubWorkItem): Partial<GitHubWorkItem> => {
    const next = applyTaskChange(row, change)
    return {
      ...(change.title === undefined ? {} : { title: next.title }),
      ...(change.state === undefined ? {} : { state: next.state }),
      ...(next.labels === row.labels ? {} : { labels: next.labels }),
      ...(next.assignees === row.assignees ? {} : { assignees: next.assignees })
    }
  }
  for (const source of sources) {
    store
      .getState()
      .patchWorkItem(item.id, patch, item.repoId, { sourceContext: source, ownerRepo })
  }
}
/** Without a tracked owner (no binding, unsupported server), copies get only this edit's change. */
export function untrackedTaskOperation(
  store: Pick<StoreApi<AppState>, 'getState'>,
  item: GitHubWorkItem,
  change: TaskChange,
  sources: TaskSources
) {
  publishTaskChange(store, item, change, sources)
  return (success: boolean) => {
    if (!success) {
      publishTaskChange(store, item, revertTaskChange(change, item), sources)
    }
    return success ? applyTaskChange(item, change) : item
  }
}
