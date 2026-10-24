import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'
import { pickTuiAgent } from './tui-agent-selection'

/** The `--agent` value that asks the execution host for the user's default agent. */
export const DEFAULT_LAUNCH_AGENT_SELECTOR = 'default'

/** Where the default agent would run: an existing workspace, or the repo a new worktree comes from. */
export type DefaultLaunchAgentTarget =
  | { kind: 'existing'; worktree: string }
  | { kind: 'create-worktree'; repo: string; repoHostId?: string }

export type DefaultLaunchAgentResolution =
  | {
      agent: TuiAgent
      /** `configured`: the user's default; `automatic`: the shared fallback order picked it. */
      selection: 'configured' | 'automatic'
      /** The configured default this host skipped because it is not installed or is disabled. */
      unavailableConfiguredAgent?: TuiAgent
    }
  | { agent: null; reason: 'shell_only' | 'none_available' }

/** The desktop's new-agent rule, applied to agents detected on the host that will run the launch. */
export async function resolveDefaultLaunchAgent(
  settings: Partial<Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>>,
  detectAgents: () => Promise<readonly string[]>
): Promise<DefaultLaunchAgentResolution> {
  const preferred = settings.defaultTuiAgent ?? null
  // Why before detection: `blank` is an explicit shell-only choice, not a missing preference.
  if (preferred === 'blank') {
    return { agent: null, reason: 'shell_only' }
  }
  const detected = (await detectAgents()).filter(isTuiAgent)
  const agent = pickTuiAgent(preferred, detected, settings.disabledTuiAgents)
  if (!agent) {
    return { agent: null, reason: 'none_available' }
  }
  if (agent === preferred) {
    return { agent, selection: 'configured' }
  }
  return {
    agent,
    selection: 'automatic',
    ...(preferred ? { unavailableConfiguredAgent: preferred } : {})
  }
}
