import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { BACKLOG_TASKS_CAPABILITY } from '../../../shared/backlog-capability'
import {
  BacklogReply,
  BACKLOG_RPC_TIMEOUT_MS,
  type BacklogOperation,
  type BacklogTask
} from '../../../shared/backlog-types'
import { callRuntimeRpc, assertRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'
import { buildContainedLinkedContextBlock } from './linked-work-item-context'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'

/** Requires advertised support for runtime hosts; local and SSH support is checked when executing. */
export function supportsBacklog(
  repo: Repo,
  hosts: ReadonlyMap<ExecutionHostId, Pick<ExecutionHostRegistryEntry, 'capabilities'>>
): boolean {
  const hostId = getRepoExecutionHostId(repo)
  return (
    !hostId.startsWith('runtime:') ||
    Boolean(hosts.get(hostId)?.capabilities?.includes(BACKLOG_TASKS_CAPABILITY))
  )
}

/** Keys project UI state by host, repo ID, and checkout path to avoid cross-host reuse. */
export function backlogRepoKey(repo: Repo): string {
  return JSON.stringify([getRepoExecutionHostId(repo), repo.id, repo.path])
}

/** Uses the owning runtime (local runtime routes SSH), checks runtime capability, and validates the reply. */
export async function callBacklog(repo: Repo, operation: BacklogOperation): Promise<BacklogReply> {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  const target =
    host?.kind === 'runtime'
      ? { kind: 'environment' as const, environmentId: host.environmentId }
      : { kind: 'local' as const }
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      BACKLOG_TASKS_CAPABILITY,
      'Update the project’s Orca server to use Backlog.md.'
    )
  }
  return BacklogReply.parse(
    await callRuntimeRpc(
      target,
      'backlog.execute',
      { repoId: repo.id, operation },
      { timeoutMs: BACKLOG_RPC_TIMEOUT_MS }
    )
  )
}

/** Pairs CLI workflow instructions with contained task/source data for a reviewable composer draft. */
export function buildBacklogTaskPrompt(task: BacklogTask, context: TaskSourceContext): string {
  return [
    `Work on Backlog.md task ${task.id}. Read the current task with the project Backlog CLI and follow the project workflow. Do not hand-edit task Markdown.`,
    buildContainedLinkedContextBlock({
      provider: 'backlog',
      version: 1,
      renderedText: `Project: ${context.projectId}\nHost: ${context.hostId}\nSource checkout: ${context.providerIdentity?.provider === 'backlog' ? context.providerIdentity.projectPath : ''}\nTask: ${task.id}\nTitle: ${task.title}\n\n${task.body}`
    })
  ].join('\n\n')
}

/** Rejects Backlog launches after repo ID or host changes; other task providers are unaffected. */
export function assertBacklogLaunchTarget(context: TaskSourceContext | null, repo: Repo): void {
  if (context?.provider !== 'backlog') {
    return
  }
  if (context.repoId !== repo.id || context.hostId !== getRepoExecutionHostId(repo)) {
    throw new Error(
      'Select the Backlog task’s original project and execution host before launching.'
    )
  }
}
