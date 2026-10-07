import type { GlobalSettings } from './global-settings-types'
import { isTuiAgent } from './tui-agent-config'
import {
  composeTuiAgentLaunchArgsRecord,
  composeTuiAgentLaunchEnvRecord,
  normalizeStoredAgentLaunchArgs,
  normalizeStoredAgentLaunchEnv,
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord,
  resolveComposedTuiAgentLaunchArgs,
  resolveComposedTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import { classifyTypedAgentPermissions } from './tui-agent-permission-args'
import {
  cutTuiAgentBypassFlag,
  liftTuiAgentBypassArgs,
  liftTuiAgentBypassEnv
} from './tui-agent-bypass-lift'
import { resolveAgentLaunchGrammar, type AgentLaunchTarget } from './tui-agent-startup-shell'
import {
  normalizeAgentPermissionModeOverrides,
  PERMISSION_AGENT_IDS,
  resolveAgentPermissionMode,
  resolveDefaultAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV,
  type AgentPermissionMode
} from './tui-agent-permissions'
import type { TuiAgent } from './tui-agent'

export type AgentLaunchProfile = Required<
  Pick<
    GlobalSettings,
    'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionMode' | 'agentPermissionModeOverrides'
  >
>

/**
 * Turns a launch-ready profile (flag inline) into a mode plus extra text, losslessly; text left
 * whole is read as it launches at `target`. The majority mode becomes the default; a tie asks, so
 * agents added later don't silently bypass.
 */
export function liftComposedAgentLaunchProfile(
  composed:
    | Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>>
    | null
    | undefined,
  target: AgentLaunchTarget
): AgentLaunchProfile {
  const composedArgs = normalizeTuiAgentArgsRecord(composed?.agentDefaultArgs)
  const composedEnv = normalizeTuiAgentEnvRecord(composed?.agentDefaultEnv)
  const agentDefaultArgs = { ...composedArgs }
  const agentDefaultEnv = { ...composedEnv }
  const modes: Partial<Record<TuiAgent, AgentPermissionMode>> = {}
  for (const agent of PERMISSION_AGENT_IDS) {
    let bypass = false
    if (agent in YOLO_TUI_AGENT_ARGS) {
      const lifted = liftTuiAgentBypassArgs(
        agent,
        resolveComposedTuiAgentLaunchArgs(agent, composedArgs),
        target
      )
      agentDefaultArgs[agent] = lifted.extraArgs
      bypass ||= lifted.bypass
    }
    if (agent in YOLO_TUI_AGENT_ENV) {
      const lifted = liftTuiAgentBypassEnv(
        agent,
        resolveComposedTuiAgentLaunchEnv(agent, composedEnv)
      )
      agentDefaultEnv[agent] = lifted.extraEnv
      bypass ||= lifted.bypass
    }
    modes[agent] = bypass ? 'bypass' : 'ask'
  }
  const bypassCount = Object.values(modes).filter((mode) => mode === 'bypass').length
  const agentPermissionMode: AgentPermissionMode =
    bypassCount * 2 > PERMISSION_AGENT_IDS.length ? 'bypass' : 'ask'
  const agentPermissionModeOverrides: Partial<Record<TuiAgent, AgentPermissionMode>> = {}
  for (const agent of PERMISSION_AGENT_IDS) {
    const mode = modes[agent]
    if (mode && mode !== agentPermissionMode) {
      agentPermissionModeOverrides[agent] = mode
    }
  }
  return { agentDefaultArgs, agentDefaultEnv, agentPermissionMode, agentPermissionModeOverrides }
}

/**
 * Moves a bypass flag or env found in a typed profile's text into that agent's mode. An older build
 * writes the flag back into the text, so every load re-reads it instead of trusting the stored mode.
 */
export function liftAgentBypassFromTypedProfile(
  settings: Partial<
    Pick<
      GlobalSettings,
      | 'agentDefaultArgs'
      | 'agentDefaultEnv'
      | 'agentPermissionMode'
      | 'agentPermissionModeOverrides'
    >
  >
): {
  profile: Pick<
    AgentLaunchProfile,
    'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionModeOverrides'
  >
  changed: boolean
} {
  const storedArgs = normalizeTuiAgentArgsRecord(settings.agentDefaultArgs)
  const storedEnv = normalizeTuiAgentEnvRecord(settings.agentDefaultEnv)
  const agentDefaultArgs = normalizeStoredAgentLaunchArgs(storedArgs)
  const agentDefaultEnv = normalizeStoredAgentLaunchEnv(storedEnv)
  const agentPermissionModeOverrides = normalizeAgentPermissionModeOverrides(
    settings.agentPermissionModeOverrides
  )
  const defaultMode = resolveDefaultAgentPermissionMode(settings)
  // Entries an older build needs spelled out get saved once, so a downgrade launches Manual.
  let changed =
    Object.keys(agentDefaultArgs).length !== Object.keys(storedArgs).length ||
    Object.keys(agentDefaultEnv).length !== Object.keys(storedEnv).length
  for (const agent of PERMISSION_AGENT_IDS) {
    const args = agentDefaultArgs[agent] ?? ''
    // Only a flag that comes out whole; text that still sets permissions keeps deciding.
    const cutArgs = cutTuiAgentBypassFlag(agent, args)
    const liftedEnv = liftTuiAgentBypassEnv(agent, agentDefaultEnv[agent])
    if (cutArgs === args && !liftedEnv.bypass) {
      continue
    }
    if (cutArgs !== args) {
      agentDefaultArgs[agent] = cutArgs
    }
    if (liftedEnv.bypass) {
      agentDefaultEnv[agent] = liftedEnv.extraEnv
    }
    if (defaultMode === 'bypass') {
      delete agentPermissionModeOverrides[agent]
    } else {
      agentPermissionModeOverrides[agent] = 'bypass'
    }
    changed = true
  }
  return { profile: { agentDefaultArgs, agentDefaultEnv, agentPermissionModeOverrides }, changed }
}

/**
 * Applies a paired client's launch-ready args/env write. Only agents whose written value differs
 * from what settings.get publishes change, and their mode moves only when their Arguments and env
 * don't set permissions themselves; agents the write leaves out or repeats keep mode and text.
 */
export function applyComposedAgentLaunchUpdate(
  current: Partial<
    Pick<
      GlobalSettings,
      | 'agentDefaultArgs'
      | 'agentDefaultEnv'
      | 'agentPermissionMode'
      | 'agentPermissionModeOverrides'
    >
  >,
  update: Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>>,
  target: AgentLaunchTarget
): Partial<
  Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionModeOverrides'>
> {
  const publishedArgs = composeTuiAgentLaunchArgsRecord(current, target)
  const publishedEnv = composeTuiAgentLaunchEnvRecord(current)
  // An entry equal to what settings.get publishes is unchanged: older clients write back the
  // whole record, and a flag composed from a mode can't always be told apart from typed text.
  const writtenArgs = pickChanged(
    normalizeTuiAgentArgsRecord(update.agentDefaultArgs),
    publishedArgs,
    (a, b) => a === b
  )
  const writtenEnv = pickChanged(
    normalizeTuiAgentEnvRecord(update.agentDefaultEnv),
    publishedEnv,
    (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())
  )
  const lifted = liftComposedAgentLaunchProfile(
    {
      agentDefaultArgs: { ...publishedArgs, ...writtenArgs },
      agentDefaultEnv: { ...publishedEnv, ...writtenEnv }
    },
    target
  )
  const defaultMode = resolveDefaultAgentPermissionMode(current)
  const agentPermissionModeOverrides = normalizeAgentPermissionModeOverrides(
    current.agentPermissionModeOverrides
  )
  for (const agent of PERMISSION_AGENT_IDS) {
    // Arguments or env that set permissions decide the launch, so they say nothing about the mode.
    const typed = classifyTypedAgentPermissions(
      agent,
      { args: lifted.agentDefaultArgs[agent], env: lifted.agentDefaultEnv[agent] },
      resolveAgentLaunchGrammar(target)
    )
    if (!(agent in writtenArgs || agent in writtenEnv) || typed.kind !== 'none') {
      continue
    }
    const mode = resolveAgentPermissionMode(agent, lifted)
    if (mode === defaultMode) {
      delete agentPermissionModeOverrides[agent]
    } else {
      agentPermissionModeOverrides[agent] = mode
    }
  }
  return {
    ...(update.agentDefaultArgs !== undefined
      ? {
          agentDefaultArgs: {
            ...current.agentDefaultArgs,
            ...pickWritten(lifted.agentDefaultArgs, writtenArgs)
          }
        }
      : {}),
    ...(update.agentDefaultEnv !== undefined
      ? {
          agentDefaultEnv: {
            ...current.agentDefaultEnv,
            ...pickWritten(lifted.agentDefaultEnv, writtenEnv)
          }
        }
      : {}),
    agentPermissionModeOverrides
  }
}

function pickChanged<T>(
  written: Partial<Record<TuiAgent, T>>,
  published: Partial<Record<TuiAgent, T>>,
  same: (a: T, b: T) => boolean
): Partial<Record<TuiAgent, T>> {
  const changed: Partial<Record<TuiAgent, T>> = {}
  for (const [agent, value] of Object.entries(written)) {
    const before = isTuiAgent(agent) ? published[agent] : undefined
    if (
      isTuiAgent(agent) &&
      value !== undefined &&
      (before === undefined || !same(value, before))
    ) {
      changed[agent] = value
    }
  }
  return changed
}

/** The lifted entries for the agents a write named. */
function pickWritten<T>(
  lifted: Partial<Record<TuiAgent, T>>,
  written: Partial<Record<TuiAgent, unknown>>
): Partial<Record<TuiAgent, T>> {
  const picked: Partial<Record<TuiAgent, T>> = {}
  for (const agent of Object.keys(written)) {
    const value = isTuiAgent(agent) ? lifted[agent] : undefined
    if (isTuiAgent(agent) && value !== undefined) {
      picked[agent] = value
    }
  }
  return picked
}
