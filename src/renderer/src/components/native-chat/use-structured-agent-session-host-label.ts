import { selectNamedExecutionHostLabel } from '@/lib/execution-host-display-label'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '../../store'

/** Return the host’s display name, or null for unnamed paired servers; raw IDs are not names. */
export function useStructuredAgentSessionHostLabel(target: RuntimeClientTarget): string | null {
  return useAppStore((state) =>
    selectNamedExecutionHostLabel(state, executionHostIdForStructuredTarget(target))
  )
}
