import type { LocalAgentRuntime } from './CliSkillRuntimeSetup'
import { buildSkillSetupTerminalCommand } from './CliSkillRuntimeSetup'

export type SkillTerminalSnapshot = {
  copiedCommand: string
  executionCommand: string
  shellOverride: string | undefined
}

export function createTerminalSnapshot(
  copiedCommand: string,
  shellOverride: string | undefined,
  runtime: LocalAgentRuntime | undefined
): SkillTerminalSnapshot {
  return {
    copiedCommand,
    executionCommand: buildSkillSetupTerminalCommand(copiedCommand, shellOverride, runtime),
    shellOverride
  }
}
