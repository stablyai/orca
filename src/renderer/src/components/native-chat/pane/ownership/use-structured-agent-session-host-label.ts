import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { useAppStore } from '../../../../store/index'

/** Return the host’s display name, or null for unnamed paired servers; raw IDs are not names. */
export function useStructuredAgentSessionHostLabel(target: RuntimeClientTarget): string | null {
  return useAppStore((state) => {
    const label = selectExecutionHostDisplayLabel(state, executionHostIdForStructuredTarget(target))
    return target.kind === 'environment' && label === target.environmentId ? null : label
  })
}
