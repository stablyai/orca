import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-startup-plan-inputs'
import { resolveAgentLaunchCommand } from '../../../../shared/tui-agent-launch-command'
import { tokenizeStartupCommand } from '../../../../shared/tui-agent-startup-shell'
import {
  agentPickerLaunchInputs,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

export const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
    ]
  }
}

export function compilePickerTerminalLaunch(draft: AgentPickerDraft, entry: AgentPickerEntry) {
  const compiled = resolveAgentLaunchCommand({
    ...resolveAgentStartupPlanInputs({
      agent: entry.agent,
      settings: { agentCmdOverrides: { [entry.agent]: entry.agent } },
      ...agentPickerLaunchInputs(draft, entry),
      platform: 'linux',
      shell: 'posix',
      isRemote: false
    }),
    shell: 'posix'
  })
  if (!compiled.ok) {
    throw new Error(compiled.error)
  }
  return tokenizeStartupCommand(compiled.command, 'posix')
}
