import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { agentPickerEntriesFromRows } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { buildNewTabAgentMenuRows } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'

export function qwenWorkPickerEntries() {
  const rows = buildNewTabAgentMenuRows({
    settings: null,
    detectedOnHost: [],
    chatAgents: ['qwenwork'],
    hostChatAnswer: (agent) => (agent === 'qwenwork' ? 'yes' : 'not-on-host'),
    chatProgram: (agent) => (agent === 'qwenwork' ? 'available' : 'missing')
  })
  return agentPickerEntriesFromRows(
    rows,
    [],
    () => ({ terminal: {}, structured: {} }),
    getAgentLabel,
    null
  )
}
