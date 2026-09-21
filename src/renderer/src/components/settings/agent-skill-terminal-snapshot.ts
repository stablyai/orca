import type { LocalAgentRuntime } from './CliSkillRuntimeSetup'
import { buildSkillSetupTerminalCommand } from './CliSkillRuntimeSetup'

export type SkillTerminalSnapshot = {
  copiedCommand: string
  prepareCommandForShell: (command: string, effectiveShell: string | undefined) => string
  shellOverride: string | undefined
}

export function createTerminalSnapshot(
  copiedCommand: string,
  shellOverride: string | undefined,
  runtime: LocalAgentRuntime | undefined
): SkillTerminalSnapshot {
  const pinnedRuntime = runtime ? { ...runtime } : undefined
  return {
    copiedCommand,
    prepareCommandForShell: (command, effectiveShell) =>
      buildSkillSetupTerminalCommand(command, effectiveShell, pinnedRuntime),
    shellOverride
  }
}
