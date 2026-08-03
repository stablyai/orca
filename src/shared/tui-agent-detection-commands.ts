import type { TuiAgent } from './types'
import {
  getTuiAgentDetectCommands,
  TUI_AGENT_CONFIG,
  type TuiAgentConfig,
  type TuiAgentDetectionRuntime
} from './tui-agent-config'

export type TuiAgentDetectionCommand = {
  id: TuiAgent
  cmd: string
  requiredCommands?: readonly string[]
  unsupportedRuntimes?: readonly TuiAgentDetectionRuntime[]
}

export const KNOWN_TUI_AGENT_DETECTION_COMMANDS = buildTuiAgentDetectionCommands()

function buildTuiAgentDetectionCommands(): TuiAgentDetectionCommand[] {
  return Object.entries(TUI_AGENT_CONFIG).flatMap(([id, config]) =>
    getTuiAgentDetectCommands(config).map((cmd) =>
      buildTuiAgentDetectionCommand(id as TuiAgent, cmd, config)
    )
  )
}

function buildTuiAgentDetectionCommand(
  id: TuiAgent,
  cmd: string,
  config: TuiAgentConfig
): TuiAgentDetectionCommand {
  return {
    id,
    cmd,
    ...(config.detectRequiredCommands?.length
      ? { requiredCommands: config.detectRequiredCommands }
      : {}),
    ...(config.detectUnsupportedRuntimes?.length
      ? { unsupportedRuntimes: config.detectUnsupportedRuntimes }
      : {})
  }
}

export function getTuiAgentDetectionProbeCommands(
  commands: readonly TuiAgentDetectionCommand[],
  runtime: TuiAgentDetectionRuntime
): string[] {
  return [
    ...new Set(
      commands
        .filter((command) => !isDetectionUnsupportedInRuntime(command, runtime))
        .flatMap((command) => [command.cmd, ...(command.requiredCommands ?? [])])
    )
  ]
}

export function resolveDetectedTuiAgentIds(
  commands: readonly TuiAgentDetectionCommand[],
  foundCommands: ReadonlySet<string>,
  runtime: TuiAgentDetectionRuntime
): TuiAgent[] {
  const detected = commands
    .filter(
      (command) =>
        !isDetectionUnsupportedInRuntime(command, runtime) &&
        foundCommands.has(command.cmd) &&
        (command.requiredCommands ?? []).every((required) => foundCommands.has(required))
    )
    .map(({ id }) => id)
  return [...new Set(detected)]
}

/**
 * Which executable name matched for each detected agent, primary name first.
 *
 * Why: agents with `detectCmdAliases` can be installed under more than one binary
 * name, and only detection knows which one this host actually has on PATH.
 */
export function resolveDetectedTuiAgentExecutables(
  commands: readonly TuiAgentDetectionCommand[],
  foundCommands: ReadonlySet<string>,
  runtime: TuiAgentDetectionRuntime
): Partial<Record<TuiAgent, string>> {
  const executables: Partial<Record<TuiAgent, string>> = {}
  for (const command of commands) {
    if (
      isDetectionUnsupportedInRuntime(command, runtime) ||
      !foundCommands.has(command.cmd) ||
      executables[command.id] !== undefined ||
      !(command.requiredCommands ?? []).every((required) => foundCommands.has(required))
    ) {
      continue
    }
    executables[command.id] = command.cmd
  }
  return executables
}

export function isDetectionUnsupportedInRuntime(
  command: TuiAgentDetectionCommand,
  runtime: TuiAgentDetectionRuntime
): boolean {
  return command.unsupportedRuntimes?.includes(runtime) === true
}
