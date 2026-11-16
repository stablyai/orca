import { tuiAgentDisplayName } from '../catalog/tui-agent-display-names'

export function setupStartFailure(agent: string): string {
  return `${tuiAgentDisplayName(agent) ?? agent} did not start because Setup did not finish successfully. Check the Setup terminal and try again.`
}
