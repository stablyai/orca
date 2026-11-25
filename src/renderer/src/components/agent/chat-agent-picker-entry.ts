import { keptSetupCatalog } from '../../../../shared/agent-launch/picker/agent-launch-kept-setup-catalog'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

export function chatAgentPickerEntry(
  entry: AgentPickerEntry,
  keptSetup: NonNullable<AgentPickerEntry['keptSetup']> = {}
): AgentPickerEntry {
  return {
    ...entry,
    catalog: keptSetupCatalog(entry.agent, entry.catalog),
    surfaces: entry.surfaces.includes('chat') ? ['chat'] : [],
    defaultSurface: 'chat',
    arguments: '',
    keptSetup
  }
}
