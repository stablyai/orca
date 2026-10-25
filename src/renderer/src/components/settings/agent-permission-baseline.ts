import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  AUTO_TUI_AGENT_ARGS,
  type AgentPermissionMode
} from '../../../../shared/tui-agent-permissions'

type PresetMode = Exclude<AgentPermissionMode, 'mixed'>

/** Most common preset mode; ties keep the first seen. Custom-argument agents don't vote. */
export function majorityPermissionMode(modes: Iterable<AgentPermissionMode>): PresetMode | null {
  const counts = new Map<PresetMode, number>()
  for (const mode of modes) {
    if (mode !== 'mixed') {
      counts.set(mode, (counts.get(mode) ?? 0) + 1)
    }
  }
  let best: PresetMode | null = null
  for (const [mode, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) {
      best = mode
    }
  }
  return best
}

/** Mode the global control implies per agent; when it implies none, the most common mode is the baseline. */
export function buildAgentPermissionBaseline(
  modes: ReadonlyMap<TuiAgent, AgentPermissionMode>,
  globalMode: AgentPermissionMode,
  nonAutoMode: AgentPermissionMode | undefined
): (agent: TuiAgent) => PresetMode | null {
  if (globalMode === 'manual' || globalMode === 'yolo') {
    return () => globalMode
  }
  if (globalMode === 'auto') {
    const others =
      nonAutoMode === 'manual' || nonAutoMode === 'yolo'
        ? nonAutoMode
        : majorityPermissionMode(
            [...modes].filter(([agent]) => !(agent in AUTO_TUI_AGENT_ARGS)).map(([, mode]) => mode)
          )
    return (agent) => (agent in AUTO_TUI_AGENT_ARGS ? 'auto' : others)
  }
  const baseline = majorityPermissionMode(modes.values())
  return () => baseline
}
