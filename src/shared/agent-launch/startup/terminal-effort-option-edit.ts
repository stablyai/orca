import { reconcileAgentChoiceArgsDetailed } from '../choices/agent-choice-reconciliation'
import type { TuiAgent } from '../catalog/tui-agent'

/** Delete only effort text the existing source grammar can attribute safely. */
export function clearTerminalEffortArgs(agent: TuiAgent, userArgs: string): string {
  const keys = new Set(['effort'])
  const source = reconcileAgentChoiceArgsDetailed({
    agent,
    userArgs,
    choices: {},
    mode: 'load',
    keys
  })
  return reconcileAgentChoiceArgsDetailed({
    agent,
    userArgs,
    choices: source.sourceChoices,
    mode: 'choice-edit',
    keys,
    patch: { options: { effort: null } },
    sourceEdit: true
  }).userArgs
}
