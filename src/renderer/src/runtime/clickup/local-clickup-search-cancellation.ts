import type { ClickUpTask } from '../../../../shared/clickup/clickup-types'
import type { ClickUpApi } from '../../../../preload/api/work-items/clickup-api'
import { searchLocalWithCancellation } from '../issue-search/local-search-cancellation'

export type ClickUpSearchArgs = Omit<Parameters<ClickUpApi['searchTasks']>[0], 'requestId'>

export function searchLocalClickUpTasks(
  args: ClickUpSearchArgs,
  signal: AbortSignal
): Promise<ClickUpTask[]> {
  return searchLocalWithCancellation({
    providerLabel: 'ClickUp',
    signal,
    search: (requestId) => window.api.clickup.searchTasks({ ...args, requestId }),
    cancel: (requestId) => window.api.clickup.cancelSearchTasks({ requestId })
  })
}
