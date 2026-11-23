import type { StateCreator } from 'zustand'
import type { CacheEntry } from '../../github/cache/cache-model'
import type { AppState } from '../../types'
import type {
  ClickUpComment,
  ClickUpCommentResult,
  ClickUpConnectionStatus,
  ClickUpConnectResult,
  ClickUpMutationResult,
  ClickUpStatusOption,
  ClickUpTask,
  ClickUpTaskListFilter,
  ClickUpTaskPage
} from '../../../../../shared/clickup/clickup-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type ClickUpReadOptions = {
  /** The task-source owner of the read; it names the host the read goes to. */
  sourceContext: TaskSourceContext
  force?: boolean
}

export type ClickUpSlice = {
  clickupStatus: ClickUpConnectionStatus
  clickupStatusChecked: boolean
  /** Context key of the owner whose connection status the slot holds. */
  clickupStatusContextKey: string | null
  /** The host revoked the saved token while ClickUp was connected, so the user must reconnect. */
  clickupConnectionLost: boolean
  clickupTaskCache: Record<string, CacheEntry<ClickUpTask>>
  clickupListCache: Record<string, CacheEntry<ClickUpTaskPage>>
  clickupCommentCache: Record<string, CacheEntry<ClickUpComment[]>>
  clickupStatusOptionsCache: Record<string, CacheEntry<ClickUpStatusOption[]>>

  checkClickUpConnection: (owner: RuntimeClientTarget) => Promise<void>
  connectClickUp: (owner: RuntimeClientTarget, token: string) => Promise<ClickUpConnectResult>
  testClickUpConnection: (owner: RuntimeClientTarget) => Promise<ClickUpConnectResult>
  selectClickUpWorkspace: (owner: RuntimeClientTarget, workspaceId: string) => Promise<void>
  disconnectClickUp: (owner: RuntimeClientTarget) => Promise<void>
  listClickUpTasks: (
    args: { filter: ClickUpTaskListFilter; page: number },
    options: ClickUpReadOptions
  ) => Promise<ClickUpTaskPage>
  searchClickUpTasks: (
    query: string,
    filter: ClickUpTaskListFilter,
    options: ClickUpReadOptions
  ) => Promise<ClickUpTask[]>
  fetchClickUpTask: (id: string, options: ClickUpReadOptions) => Promise<ClickUpTask | null>
  listClickUpTaskComments: (id: string, options: ClickUpReadOptions) => Promise<ClickUpComment[]>
  listClickUpStatusOptions: (
    listId: string,
    options: ClickUpReadOptions
  ) => Promise<ClickUpStatusOption[]>
  addClickUpTaskComment: (
    id: string,
    body: string,
    options: ClickUpReadOptions
  ) => Promise<ClickUpCommentResult>
  /** Patches every cached copy at once, then rolls back when ClickUp rejects the change. */
  updateClickUpTaskStatus: (
    task: ClickUpTask,
    status: ClickUpStatusOption,
    options: ClickUpReadOptions
  ) => Promise<ClickUpMutationResult>
}

type ClickUpStateCreator = StateCreator<AppState, [], [], ClickUpSlice>

export type ClickUpSliceSet = Parameters<ClickUpStateCreator>[0]
export type ClickUpSliceGet = Parameters<ClickUpStateCreator>[1]
