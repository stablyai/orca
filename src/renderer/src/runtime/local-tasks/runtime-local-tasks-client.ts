import type { LocalTaskListResult } from '../../../../shared/local-tasks/local-task-types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'

/** Tasks live on the host that owns the project: a server over RPC, this app over IPC (as Jira does). */
export async function localTasksListForTarget(
  target: RuntimeClientTarget
): Promise<LocalTaskListResult> {
  return target.kind === 'environment'
    ? callRuntimeRpc<LocalTaskListResult>(target, 'localTasks.list', undefined, {
        timeoutMs: 15_000
      })
    : window.api.localTasks.list()
}
