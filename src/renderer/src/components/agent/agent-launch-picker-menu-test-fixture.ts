import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { resolveAgentLaunchCommand } from '../../../../shared/agent-launch/startup/tui-agent-launch-command'
import { tokenizeStartupCommand } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import {
  agentPickerLaunchInputs,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

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
