import { useAppStore } from '@/store'
import { DEFAULT_AGENT_ROW_DISPLAY_FIELDS, agentRowShowsField } from '../../../../shared/constants'
import type { AgentRowDisplayField } from '../../../../shared/types'

/** Resolved agent-row field visibility from persisted UI (all on when unset). */
export function useAgentRowDisplayFields(): {
  showProviderIcon: boolean
  showSecondaryStatus: boolean
  showModel: boolean
  showRelativeTime: boolean
  fields: readonly AgentRowDisplayField[]
} {
  const fields = useAppStore((s) => s.agentRowDisplayFields) ?? DEFAULT_AGENT_ROW_DISPLAY_FIELDS
  return {
    fields,
    showProviderIcon: agentRowShowsField(fields, 'provider-icon'),
    showSecondaryStatus: agentRowShowsField(fields, 'secondary-status'),
    showModel: agentRowShowsField(fields, 'model'),
    showRelativeTime: agentRowShowsField(fields, 'relative-time')
  }
}
