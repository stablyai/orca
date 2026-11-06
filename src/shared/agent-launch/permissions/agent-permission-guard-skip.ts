import { agentPermissionHostPlatform, permissionEnvNameMatches } from './agent-permission-env'
import type { AgentPermissionChoice } from './tui-agent-permission-choice'
import type { TuiAgent } from '../catalog/tui-agent'

/** Claude Code keeps refusing a short list of commands (`rm -rf ~` and friends) even under
 *  --dangerously-skip-permissions; this variable drops those last refusals. The CLI reads it only
 *  in that mode, and it is Claude Code's own, so no other vendor's agent is offered it. */
const PERMISSION_GUARD_SKIP_ENV = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS'

/** Agent Teams runs the same `claude` binary behind Orca's CLI wrapper, which hands the terminal's
 *  own environment to the child, so the variable arrives where the refusals live. */
const PERMISSION_GUARD_SKIP_AGENTS = ['claude', 'claude-agent-teams'] as const

/** Stored apart from the permission choice so turning Full access off and on cannot opt anyone in. */
export type AgentPermissionGuardSkipSettings = {
  /** Claude-family agents whose Full access also drops Claude Code's built-in refusals. A missing
   *  key means off: only an explicit opt-in writes one, never a migration or a default. */
  agentPermissionGuardSkip?: Partial<Record<TuiAgent, true>>
}

export function agentSupportsPermissionGuardSkip(agent: string): agent is TuiAgent {
  return PERMISSION_GUARD_SKIP_AGENTS.some((candidate) => candidate === agent)
}

/** Only a literal `true` on a Claude-family agent survives, so no stray stored value opts in. */
export function normalizeAgentPermissionGuardSkip(value: unknown): Partial<Record<TuiAgent, true>> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([agent, enabled]) => enabled === true && agentSupportsPermissionGuardSkip(agent))
      .map(([agent]) => [agent, true])
  )
}

export function agentPermissionGuardSkipEnabled(
  agent: string,
  settings: AgentPermissionGuardSkipSettings | null | undefined
): boolean {
  return (
    agentSupportsPermissionGuardSkip(agent) && settings?.agentPermissionGuardSkip?.[agent] === true
  )
}

/** The variable Orca adds for an opted-in agent; empty under every other choice, because the CLI
 *  ignores it unless --dangerously-skip-permissions is what put it in bypass mode. */
export function agentPermissionGuardSkipEnv(
  agent: string,
  choice: AgentPermissionChoice,
  settings: AgentPermissionGuardSkipSettings | null | undefined
): Record<string, string> {
  return choice === 'full-access' && agentPermissionGuardSkipEnabled(agent, settings)
    ? { [PERMISSION_GUARD_SKIP_ENV]: '1' }
    : {}
}

/** Orca adds this entry at launch, so a settings write must never keep it as one of the user's own:
 *  stored that way it would outlive the opt-in it came from. */
export function withoutAgentPermissionGuardSkipEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform | null | undefined = agentPermissionHostPlatform()
): Record<string, string> {
  const rest = { ...env }
  for (const name of Object.keys(rest)) {
    if (permissionEnvNameMatches(name, PERMISSION_GUARD_SKIP_ENV, platform)) {
      delete rest[name]
    }
  }
  return rest
}

/** Absence is off, so turning it off drops the key rather than storing a false. */
export function applyAgentPermissionGuardSkip(
  settings: AgentPermissionGuardSkipSettings,
  agent: TuiAgent,
  enabled: boolean
): Required<AgentPermissionGuardSkipSettings> {
  const next = { ...settings.agentPermissionGuardSkip }
  if (enabled) {
    next[agent] = true
  } else {
    delete next[agent]
  }
  return { agentPermissionGuardSkip: next }
}
