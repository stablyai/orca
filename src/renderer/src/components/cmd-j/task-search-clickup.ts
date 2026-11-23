import { useAppStore } from '@/store'
import { clickupOwnerContextKey } from '@/store/slices/clickup/clickup-read-coordination'
import { bindClickUpTaskSourceContext } from '@/lib/work-items/clickup/clickup-task-source-context'
import type { ClickUpTaskListFilter } from '../../../../shared/clickup/clickup-types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import { makeCmdJTaskSearchResult, type CmdJTaskSearchResult } from './task-search-results'

const RESULT_LIMIT = 12

const SEARCH_FILTER: ClickUpTaskListFilter = { scope: 'all', includeClosed: false }

/**
 * Open tasks of the connected ClickUp Workspace whose name or id matches the query. The store serves
 * repeat queries from its cache, and a disconnected host answers with no tasks, so no status read is needed.
 */
export async function searchClickUpForCmdJ(
  source: TaskSourceContext,
  target: RuntimeClientTarget,
  query: string,
  signal: AbortSignal,
  initialRepoId: string | null,
  hostLabel: string
): Promise<CmdJTaskSearchResult[]> {
  if (signal.aborted) {
    return []
  }
  const tasks = await useAppStore
    .getState()
    .searchClickUpTasks(query, SEARCH_FILTER, { sourceContext: source, signal })
  const state = useAppStore.getState()
  // The status slot describes one host at a time; another host's Workspaces would name the wrong account.
  const workspaces =
    state.clickupStatusContextKey === clickupOwnerContextKey(target)
      ? state.clickupStatus.workspaces
      : []
  return tasks.slice(0, RESULT_LIMIT).flatMap((task) => {
    const itemSource = bindClickUpTaskSourceContext({
      task,
      workspaces,
      sourceContext: source
    })
    return itemSource
      ? [
          makeCmdJTaskSearchResult(
            { provider: 'clickup', task },
            itemSource,
            initialRepoId,
            hostLabel
          )
        ]
      : []
  })
}
