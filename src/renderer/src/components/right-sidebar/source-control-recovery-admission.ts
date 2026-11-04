import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getRuntimeGitMutationInFlight } from '@/runtime/runtime-git-status-client'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

export function sourceControlRecoveryScopeKey(context: RuntimeGitContext): string {
  return JSON.stringify([
    context.target.kind === 'environment' ? context.target.environmentId : 'local',
    context.connectionId ?? null,
    normalizeRuntimePathForComparison(context.worktreePath)
  ])
}

/** Blocks only on Orca Git work the host reports; the agent's prompt covers Git started elsewhere. */
export async function admitSourceControlRecovery(
  context: RuntimeGitContext,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    if (!(await getRuntimeGitMutationInFlight(context)).inFlight) {
      return !signal?.aborted
    }
  } catch {
    // Older hosts lack the method; an unreachable host fails the launch itself.
    return !signal?.aborted
  }
  if (signal?.aborted) {
    return false
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.run.source.control.agent.action.start.git.operation.running',
      'Wait for the running Git operation to finish.'
    )
  )
  return false
}
