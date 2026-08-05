import type { TuiAgent } from './types'
import {
  getTuiAgentDetectCommands,
  TUI_AGENT_CONFIG,
  type TuiAgentConfig,
  type TuiAgentDetectionRuntime
} from './tui-agent-config'
import { detectedAgentInventory, type DetectedAgentInventoryV1 } from './detected-agent-inventory'

export type TuiAgentDetectionCommand = {
  id: TuiAgent
  cmd: string
  capabilityProbe?: {
    args: readonly string[]
    matchedCommand: string
  }
  requiredCommands?: readonly string[]
  unsupportedRuntimes?: readonly TuiAgentDetectionRuntime[]
}

export type DetectedTuiAgentsResult = DetectedAgentInventoryV1

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
    ...(id === 'cursor'
      ? {
          capabilityProbe: {
            args: cmd === 'cursor' ? ['agent', '--help'] : ['--help'],
            matchedCommand: cmd === 'cursor' ? 'cursor agent' : 'cursor-agent'
          }
        }
      : {}),
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

export function resolveDetectedTuiAgents(
  commands: readonly TuiAgentDetectionCommand[],
  foundCommands: ReadonlySet<string>,
  runtime: TuiAgentDetectionRuntime,
  capableCommands: ReadonlySet<string> = foundCommands
): DetectedTuiAgentsResult {
  const eligible = commands.filter(
    (command) =>
      !isDetectionUnsupportedInRuntime(command, runtime) &&
      foundCommands.has(command.cmd) &&
      (!command.capabilityProbe || capableCommands.has(command.cmd)) &&
      (command.requiredCommands ?? []).every((required) => foundCommands.has(required))
  )
  const agents = [...new Set(eligible.map((command) => command.id))]
  const matchedCommands: Partial<Record<TuiAgent, string>> = {}
  for (const command of eligible) {
    if (matchedCommands[command.id] === undefined) {
      matchedCommands[command.id] = command.capabilityProbe?.matchedCommand ?? command.cmd
    }
  }
  return detectedAgentInventory(agents, matchedCommands)
}

export function isDetectionUnsupportedInRuntime(
  command: TuiAgentDetectionCommand,
  runtime: TuiAgentDetectionRuntime
): boolean {
  return command.unsupportedRuntimes?.includes(runtime) === true
}
