import type {
  AgentLaunchSettings,
  AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch-settings'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import {
  AUTO_TUI_AGENT_ARGS,
  hasConfigurableTuiAgentPermissions,
  resolveTuiAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS,
  type AgentPermissionMode
} from '../../../../shared/tui-agent-permissions'
import { buildAgentPermissionBaseline, majorityPermissionMode } from './agent-permission-baseline'
import type { AgentRowPermission } from './AgentRowPermissions'

export function buildAgentRowPermissions({
  agents,
  settings,
  localEnv,
  autoSupported,
  save
}: {
  agents: readonly TuiAgent[]
  settings: AgentLaunchSettings
  /** Local env values; hosts publish only names, so env-only agents can't be read there. */
  localEnv: Partial<Record<TuiAgent, Record<string, string>>> | null
  autoSupported: boolean
  save: (mutation: AgentLaunchSettingsMutation) => void
}): {
  globalMode: AgentPermissionMode
  majorityMode: Exclude<AgentPermissionMode, 'mixed'> | null
  rows: ReadonlyMap<TuiAgent, AgentRowPermission>
} {
  const globalMode = settings.autoPermissionMode ? 'auto' : settings.permissionMode
  const modes = new Map<TuiAgent, AgentPermissionMode>()
  for (const agent of agents) {
    // Older hosts take only argument edits, which can't express env-only presets.
    const editable = autoSupported || agent in YOLO_TUI_AGENT_ARGS
    if (
      hasConfigurableTuiAgentPermissions(agent) &&
      editable &&
      (localEnv !== null || agent in YOLO_TUI_AGENT_ARGS)
    ) {
      modes.set(
        agent,
        resolveTuiAgentPermissionMode({
          agent,
          agentArgs: resolveTuiAgentLaunchArgs(agent, settings),
          agentEnv: localEnv
            ? resolveTuiAgentLaunchEnv(agent, { agentDefaultEnv: localEnv })
            : undefined
        })
      )
    }
  }
  const baseline = buildAgentPermissionBaseline(modes, globalMode, settings.nonAutoPermissionMode)
  const rows = new Map<TuiAgent, AgentRowPermission>()
  for (const [agent, mode] of modes) {
    rows.set(agent, {
      mode,
      expectedMode: baseline(agent),
      autoAvailable: autoSupported && agent in AUTO_TUI_AGENT_ARGS,
      onChange: (next) =>
        save(
          autoSupported
            ? { type: 'permissions', agent, mode: next }
            : {
                type: 'arguments',
                agent,
                value: next === 'yolo' ? (YOLO_TUI_AGENT_ARGS[agent] ?? '') : ''
              }
        ),
      ...(agent in YOLO_TUI_AGENT_ARGS
        ? { reset: buildPresetReset(agent, presetFor(agent, baseline(agent)), save) }
        : {})
    })
  }
  return { globalMode, majorityMode: majorityPermissionMode(modes.values()), rows }
}

// The most common mode can be Auto even for an agent that can't run it.
function presetFor(
  agent: TuiAgent,
  mode: AgentPermissionMode | null
): Exclude<AgentPermissionMode, 'mixed'> {
  return mode === 'yolo' || (mode === 'auto' && agent in AUTO_TUI_AGENT_ARGS) ? mode : 'manual'
}

function buildPresetReset(
  agent: TuiAgent,
  mode: Exclude<AgentPermissionMode, 'mixed'>,
  save: (mutation: AgentLaunchSettingsMutation) => void
): NonNullable<AgentRowPermission['reset']> {
  // An arguments edit, since a permissions change refuses agents with custom arguments.
  const value =
    mode === 'yolo'
      ? (YOLO_TUI_AGENT_ARGS[agent] ?? '')
      : mode === 'auto'
        ? (AUTO_TUI_AGENT_ARGS[agent] ?? '')
        : ''
  return { mode, apply: () => save({ type: 'arguments', agent, value }) }
}
