import { clickupApiForTarget } from '@/runtime/clickup/runtime-clickup-client'
import { bindClickUpTaskSourceContext } from '@/lib/work-items/clickup/clickup-task-source-context'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import { makeCmdJTaskSearchResult, type CmdJTaskSearchResult } from './task-search-results'

const RESULT_LIMIT = 12

/** Open tasks of the connected ClickUp Workspace whose name or id matches the query. */
export async function searchClickUpForCmdJ(
  source: TaskSourceContext,
  target: RuntimeClientTarget,
  query: string,
  signal: AbortSignal,
  initialRepoId: string | null,
  hostLabel: string
): Promise<CmdJTaskSearchResult[]> {
  const api = clickupApiForTarget(target)
  const status = await api.status()
  if (signal.aborted || !status.connected) {
    return []
  }
  const tasks = await api.searchTasks({
    query,
    filter: { scope: 'all', includeClosed: false }
  })
  return tasks.slice(0, RESULT_LIMIT).flatMap((task) => {
    const itemSource = bindClickUpTaskSourceContext({
      task,
      workspaces: status.workspaces,
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
