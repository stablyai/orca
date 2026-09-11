import type { TuiAgent } from './tui-agent'
import {
  getTuiAgentDetectCommands,
  TUI_AGENT_CONFIG,
  type TuiAgentConfig,
  type TuiAgentDetectionRuntime
} from './tui-agent-config'
import type { TuiAgentIdentityProbe } from './tui-agent-identity-probe'
export {
  getTuiAgentIdentityProbeArgs,
  matchesTuiAgentIdentityProbe
} from './tui-agent-identity-probe'

export type TuiAgentDetectionCommand = {
  id: TuiAgent
  cmd: string
  identityProbe?: TuiAgentIdentityProbe
  requiredCommands?: readonly string[]
  unsupportedRuntimes?: readonly TuiAgentDetectionRuntime[]
}

export const KNOWN_TUI_AGENT_DETECTION_COMMANDS = buildTuiAgentDetectionCommands()
export const IDENTITY_PROBED_TUI_AGENT_IDS: ReadonlySet<string> = new Set(
  KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter((command) => command.identityProbe).map(
    (command) => command.id
  )
)

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
    ...(config.detectIdentityProbe ? { identityProbe: config.detectIdentityProbe } : {}),
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
  runtime: TuiAgentDetectionRuntime,
  identityVerifiedCommands: ReadonlySet<string> = new Set()
): TuiAgent[] {
  const detected = commands
    .filter(
      (command) =>
        !isDetectionUnsupportedInRuntime(command, runtime) &&
        foundCommands.has(command.cmd) &&
        (!command.identityProbe || identityVerifiedCommands.has(command.cmd)) &&
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
