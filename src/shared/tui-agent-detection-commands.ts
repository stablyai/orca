import type { TuiAgent } from './tui-agent'
import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgentConfig, TuiAgentDetectionRuntime } from './tui-agent-config-types'
import {
  serializeIdentityExclusion,
  type SerializedIdentityExclusion
} from './tui-agent-identity-exclusion'

export type TuiAgentDetectionCommand = {
  id: TuiAgent
  cmd: string
  requiredCommands?: readonly string[]
  unsupportedRuntimes?: readonly TuiAgentDetectionRuntime[]
  /** Serialized so the same probe runs on every detection host, including SSH relays. */
  identityExclusion?: SerializedIdentityExclusion
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
      : {}),
    ...(config.detectIdentityExclusion
      ? { identityExclusion: serializeIdentityExclusion(config.detectIdentityExclusion) }
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

export function isDetectionUnsupportedInRuntime(
  command: TuiAgentDetectionCommand,
  runtime: TuiAgentDetectionRuntime
): boolean {
  return command.unsupportedRuntimes?.includes(runtime) === true
}
