import { buildAiVaultResumeShellCommand } from '../../ai-vault/resume/ai-vault-resume-command'
import {
  generatedAgentLaunchEnv,
  type GeneratedCmdLaunchInputs
} from './generated-agent-launch-inputs'
import type { LaunchPosition } from './launch-position'
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
