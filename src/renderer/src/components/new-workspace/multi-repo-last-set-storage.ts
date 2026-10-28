import { recordCreateInLastSet, type LastMultiRepoSet } from './multi-repo-composer-model'

// Device-local, like the Jira view mode, rather than synced through ui.set: the host never sees it.
const STORAGE_KEY = 'orca.new-workspace.last-multi-repo-set.v1'

function toLastMultiRepoSet(value: unknown): LastMultiRepoSet | null {
  // `in` narrows the parsed JSON to typed fields, so no dynamic property reads are needed.
  if (
    typeof value !== 'object' ||
    value === null ||
    !('projectIds' in value) ||
    !('singleCreatesSince' in value)
  ) {
    return null
  }
  const { projectIds, singleCreatesSince } = value
  if (
    !Array.isArray(projectIds) ||
    projectIds.length === 0 ||
    typeof singleCreatesSince !== 'number' ||
    !Number.isInteger(singleCreatesSince) ||
    singleCreatesSince < 0
  ) {
    return null
  }
  const ids = projectIds.filter((id): id is string => typeof id === 'string' && id !== '')
  return ids.length === projectIds.length ? { projectIds: ids, singleCreatesSince } : null
}

export function loadLastMultiRepoSet(): LastMultiRepoSet | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return null
    }
    return toLastMultiRepoSet(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveLastMultiRepoSet(value: LastMultiRepoSet | null): void {
  try {
    if (value) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // The remembered set is a shortcut; the composer works without it.
  }
}

/** A single-project create counts toward clearing the "Same as last time" link. */
export function recordSingleProjectCreate(projectId: string | null): void {
  if (!projectId) {
    return
  }
  saveLastMultiRepoSet(recordCreateInLastSet(loadLastMultiRepoSet(), [projectId]))
}
