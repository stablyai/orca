import { buildAiVaultResumeShellCommand } from '../../ai-vault/resume/ai-vault-resume-command'
import {
  generatedAgentLaunchEnv,
  type GeneratedCmdLaunchInputs
} from './generated-agent-launch-inputs'
import { readLaunchPosition, type LaunchPosition } from './launch-position'
import { launchProgramHead } from './managed-agent-launch-program'

export function renderGeneratedCmdLaunch(
  inputs: GeneratedCmdLaunchInputs,
  executable = inputs.executable
): string {
  return buildAiVaultResumeShellCommand({
    ...inputs,
    resumeCommand: launchProgramHead(executable, 'cmd') + inputs.args,
    platform: 'win32',
    shell: 'cmd'
  })
}

export function generatedCmdLaunchEnv(
  executable: string | undefined,
  invocation: string,
  options: Pick<GeneratedCmdLaunchInputs, 'cwd' | 'codexHome' | 'clearEnvNames'> = { cwd: null }
): Record<string, string> | undefined {
  if (!executable) {
    return undefined
  }
  const head = launchProgramHead(executable, 'cmd')
  const args = invocation.slice(head.length)
  if (!invocation.startsWith(head) || (args && !/^[ \t]/.test(args))) {
    return undefined
  }
  const { cwd, codexHome, clearEnvNames } = options
  return generatedAgentLaunchEnv({ kind: 'cmd', executable, args, cwd, codexHome, clearEnvNames })
}

export function generatedCmdResumeEnv(
  recipe: { agentCommand: string; selectedExecutable?: string },
  recorded: boolean,
  invocation: string,
  options: Parameters<typeof generatedCmdLaunchEnv>[2]
): Record<string, string> | undefined {
  const executable = recorded
    ? (recipe.selectedExecutable ?? readLaunchPosition(recipe.agentCommand, 'cmd')?.executable)
    : (recipe.selectedExecutable ?? recipe.agentCommand.split(' ')[0])
  return generatedCmdLaunchEnv(executable, invocation, options)
}

/** Conversion only needs the trailing arguments, cwd and environment from the verified command. */
export function generatedCmdLaunchPosition(
  inputs: GeneratedCmdLaunchInputs,
  command: string
): Pick<LaunchPosition, 'end' | 'cwd' | 'env'> {
  const env = new Map<string, string | undefined>()
  for (const name of inputs.clearEnvNames ?? []) {
    env.set(name, undefined)
  }
  const codexHome = inputs.codexHome?.trim()
  if (codexHome) {
    env.delete('CODEX_HOME')
    env.set('CODEX_HOME', codexHome)
  }
  return { end: command.length - inputs.args.length, cwd: inputs.cwd || undefined, env }
}
