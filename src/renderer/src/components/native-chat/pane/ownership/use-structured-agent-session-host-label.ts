import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useAppStore } from '../../../../store/index'

/** Return the host’s display name, or null for unnamed paired servers; raw IDs are not names. */
export function useStructuredAgentSessionHostLabel(target: RuntimeClientTarget): string | null {
  const t = useTranslate()
  return useAppStore((state) => {
    const label = selectExecutionHostDisplayLabel(
      state,
      executionHostIdForStructuredTarget(target),
      { t }
    )
    return target.kind === 'environment' && label === target.environmentId ? null : label
  })
}
