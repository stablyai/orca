import { parseExecutionHostId } from '../../../shared/execution-host'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

/**
 * Transport to a row-less source's host; a source that names no server runs on this app. The
 * unresolved-owner sentinel stays a server target so the call fails instead of running locally.
 */
export function taskSourceRuntimeTarget(
  context: Pick<TaskSourceContext, 'hostId'> | null | undefined
): RuntimeClientTarget {
  const parsed = parseExecutionHostId(context?.hostId)
  return parsed?.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsed.environmentId }
    : { kind: 'local' }
}
