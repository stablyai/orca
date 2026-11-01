import type {
  AgentDedicatedChoices,
  AgentChoicePatch
} from '../../../../shared/agent-launch-choices'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { analyzeAgentChoiceArgs } from '../../../../shared/agent-choice-args'
import { projectAgentLaunchProfile } from '../../../../shared/agent-launch-profile'
import type { AgentArgsChoice } from './AgentPermissionChoiceControls'

export function agentModelChoiceChips(
  agent: TuiAgent | null | undefined,
  label: string,
  selected: AgentDedicatedChoices | undefined,
  onRemove: (patch: AgentChoicePatch, text: string) => string
): AgentArgsChoice[] {
  if (!agent || !selected) {
    return []
  }
  const projection = projectAgentLaunchProfile(
    agent,
    { agentPermissionDefault: 'own' },
    {
      target: 'terminal',
      userArgs: '',
      choices: selected
    }
  )
  const analysis = analyzeAgentChoiceArgs(agent, projection.args)
  return [...analysis.occurrences]
    .sort((a, b) => Number(b.key === 'permissionMode') - Number(a.key === 'permissionMode'))
    .flatMap(({ key, start, end }) => {
      const chosen =
        key === 'model'
          ? selected.model
          : key === 'permissionMode'
            ? selected.permissionMode
            : selected.options?.[key]
      if (chosen === undefined) {
        return []
      }
      return [
        {
          key,
          label,
          flag: projection.args.slice(start, end),
          onRemove: (text: string) =>
            onRemove(
              key === 'model'
                ? { model: null }
                : key === 'permissionMode'
                  ? { permissionMode: 'own' }
                  : { options: { [key]: null } },
              text
            )
        }
      ]
    })
}
