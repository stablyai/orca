import type { AutomationAgentConfig } from './automations-types'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv,
  sanitizeTuiAgentLaunchArgs
} from './tui-agent-launch-defaults'
import { applyAgentModelToArgs } from './tui-agent-models'
import type { TuiAgent } from './types'

/** The slice of global settings the per-automation launch resolver reads. */
export type AutomationLaunchDefaults = {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}

/** Effective CLI args for an automation's agent: the automation's own
 *  launchArgs when set (non-empty), otherwise the global per-agent default,
 *  with the selected model flag applied on top. Keeping this in one place means
 *  the headless (main) and renderer dispatch paths produce identical commands. */
export function resolveAutomationAgentArgs(
  agent: TuiAgent,
  agentConfig: AutomationAgentConfig | null | undefined,
  defaults: AutomationLaunchDefaults
): string {
  const override = agentConfig?.launchArgs?.trim()
  const base =
    override && override.length > 0
      ? // Why: a per-automation override skips the global settings sanitizer, so
        // strip agent-incompatible flags here too (e.g. opencode/kilo removed
        // --dangerously-skip-permissions) — and re-sanitize against the CURRENT
        // agent, which may differ from when the args were saved.
        sanitizeTuiAgentLaunchArgs(agent, override)
      : resolveTuiAgentLaunchArgs(agent, defaults.agentDefaultArgs ?? undefined)
  return applyAgentModelToArgs(agent, base, agentConfig?.model)
}

/** Effective launch env: the global per-agent env with the automation's own
 *  env entries merged on top (per-automation wins per key). */
export function resolveAutomationAgentEnv(
  agent: TuiAgent,
  agentConfig: AutomationAgentConfig | null | undefined,
  defaults: AutomationLaunchDefaults
): Record<string, string> {
  const base = resolveTuiAgentLaunchEnv(agent, defaults.agentDefaultEnv ?? undefined)
  const overrides = agentConfig?.env
  if (!overrides) {
    return base
  }
  return { ...base, ...overrides }
}
