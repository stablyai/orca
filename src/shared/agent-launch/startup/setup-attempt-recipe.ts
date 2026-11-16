import { createSequencedSetupAgentCommands } from './setup-agent-sequencing'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import type { SetupRunnerCommandPlatform, SetupRunnerShell } from './setup-runner-command'

export type SetupAttemptRecipe = {
  runnerScriptPath: string
  platform: SetupRunnerCommandPlatform
  shell?: SetupRunnerShell
  nonce: string
  deadline: number
}

export function createSetupDependentCommand(
  recipe: SetupAttemptRecipe,
  startupCommand: string,
  startupShell?: AgentStartupShell,
  agent?: string
) {
  const commands = createSequencedSetupAgentCommands({
    ...recipe,
    startupCommand,
    startupShell,
    agent,
    waitTimeoutSeconds: Math.max(1, Math.ceil((recipe.deadline - Date.now()) / 1000))
  })
  return { command: commands.startupCommand, env: commands.startupEnv }
}
