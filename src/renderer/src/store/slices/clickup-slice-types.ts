import type {
  ClickUpConnectionStatus,
  ClickUpTask,
  ClickUpTaskFilter,
  ClickUpTaskScope,
  ClickUpViewer,
  ClickUpWorkspaceSelection
} from '../../../../shared/clickup-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { CacheEntry } from '../github/cache-model'

export type ClickUpReadOptions = {
  force?: boolean
  sourceContext?: TaskSourceContext | null
  // Server-side Space/Sprint/Status narrowing for list and search reads.
  taskScope?: ClickUpTaskScope
}

export function taskScopeKey(taskScope?: ClickUpTaskScope): string {
  return taskScope
    ? JSON.stringify([
        taskScope.spaceId ?? '',
        [...(taskScope.listIds ?? [])].sort(),
        [...(taskScope.statuses ?? [])].sort()
      ])
    : ''
}

export function selectedWorkspaceId(
  status: ClickUpConnectionStatus
): ClickUpWorkspaceSelection | null {
  return status.selectedWorkspaceId ?? status.activeWorkspaceId ?? null
}

export type ClickUpSlice = {
  clickUpStatus: ClickUpConnectionStatus
  clickUpStatusChecked: boolean
  clickUpStatusContextKey: string | null
  clickUpTaskCache: Record<string, CacheEntry<ClickUpTask>>
  clickUpSearchCache: Record<string, CacheEntry<ClickUpTask[]>>
  clickUpListCache: Record<string, CacheEntry<ClickUpTask[]>>

  checkClickUpConnection: (force?: boolean) => Promise<void>
  connectClickUp: (
    apiToken: string
  ) => Promise<{ ok: true; viewer: ClickUpViewer } | { ok: false; error: string }>
  testClickUpConnection: () => Promise<
    { ok: true; viewer: ClickUpViewer } | { ok: false; error: string }
  >
  disconnectClickUp: () => Promise<void>
  selectClickUpWorkspace: (workspaceId: ClickUpWorkspaceSelection) => Promise<void>
  fetchClickUpTask: (
    taskId: string,
    workspaceId?: string | null,
    options?: ClickUpReadOptions
  ) => Promise<ClickUpTask | null>
  searchClickUpTasks: (
    query: string,
    limit?: number,
    options?: ClickUpReadOptions
  ) => Promise<ClickUpTask[]>
  listClickUpTasks: (
    filter?: ClickUpTaskFilter,
    limit?: number,
    options?: ClickUpReadOptions
  ) => Promise<ClickUpTask[]>
  patchClickUpTask: (
    taskId: string,
    patch: Partial<ClickUpTask>,
    sourceContext?: TaskSourceContext | null
  ) => void
}
