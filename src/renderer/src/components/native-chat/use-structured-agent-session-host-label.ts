import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { useAppStore } from '../../store'

/** What Orca calls the chat's host; null for a paired server this client has no name for, whose
 *  raw id is not a name. */
export function useStructuredAgentSessionHostLabel(target: RuntimeClientTarget): string | null {
  return useAppStore((state) => {
    const label = selectExecutionHostDisplayLabel(state, executionHostIdForStructuredTarget(target))
    return target.kind === 'environment' && label === target.environmentId ? null : label
  })
}
