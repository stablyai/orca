import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import { getTuiAgentDefaultArgs, getTuiAgentDefaultEnv } from './tui-agent-launch-defaults'

/**
 * Whether the user configured a TUI launch this agent would lose outside a terminal.
 *
 * Shared rather than renderer-local because both launch surfaces have to answer it: the renderer
 * routes such a launch back to the TUI, and orchestration falls a worker back to a PTY so the
 * custom command, arguments and environment still apply.
 */
export function hasExplicitTuiLaunchCustomization(
  settings:
    | Partial<Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'>>
    | null
    | undefined,
  agent: TuiAgent
): boolean {
  const configuredArgs = settings?.agentDefaultArgs?.[agent]
  const configuredEnv = settings?.agentDefaultEnv?.[agent]
  const defaultEnv = getTuiAgentDefaultEnv(agent)
  const envIsCustomized =
    configuredEnv !== undefined &&
    (Object.keys(configuredEnv).length !== Object.keys(defaultEnv).length ||
      Object.entries(configuredEnv).some(([key, value]) => defaultEnv[key] !== value))
  return (
    Boolean(settings?.agentCmdOverrides?.[agent]?.trim()) ||
    hasExplicitTuiAgentArgs(agent, configuredArgs) ||
    envIsCustomized
  )
}

export function hasSemanticallyNonEmptyAgentArgs(value: string | null | undefined): boolean {
  return Boolean(value?.trim())
}

export function hasExplicitTuiAgentArgs(
  agent: TuiAgent,
  value: string | null | undefined
): boolean {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 && trimmed !== getTuiAgentDefaultArgs(agent).trim()
}
