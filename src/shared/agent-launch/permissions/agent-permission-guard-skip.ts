import { resolveAgentPermission, type AgentPermissionSettings } from './tui-agent-permission-choice'
import type { TuiAgent } from '../catalog/tui-agent'

/** Lifts the refusals (`rm -rf ~` and friends) Claude Code keeps under --dangerously-skip-permissions. */
const PERMISSION_GUARD_SKIP_ENV = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS'

/** Agent Teams runs the same `claude` binary, which inherits the terminal's environment. */
const PERMISSION_GUARD_SKIP_AGENTS = ['claude', 'claude-agent-teams'] as const

/** Stored apart from the permission choice so turning Full access off and on cannot opt anyone in. */
export type AgentPermissionGuardSkipSettings = {
  /** A missing key means off: only an explicit opt-in writes one. */
  agentPermissionGuardSkip?: Partial<Record<TuiAgent, true>>
}

type GuardSkipSettings = AgentPermissionGuardSkipSettings & AgentPermissionSettings

export function agentSupportsPermissionGuardSkip(agent: string): agent is TuiAgent {
  return PERMISSION_GUARD_SKIP_AGENTS.some((candidate) => candidate === agent)
}

// The CLI reads the variable only in the bypass mode Full access starts it in.
function guardSkipApplies(agent: string, settings: GuardSkipSettings | null | undefined): boolean {
  return (
    agentSupportsPermissionGuardSkip(agent) &&
    settings?.agentPermissionGuardSkip?.[agent] === true &&
    resolveAgentPermission(agent, settings).choice === 'full-access'
  )
}

export function agentPermissionGuardSkipEnv(
  agent: string,
  settings: GuardSkipSettings | null | undefined
): Record<string, string> {
  return guardSkipApplies(agent, settings) ? { [PERMISSION_GUARD_SKIP_ENV]: '1' } : {}
}

/** Claude Code ignores the variable while any PermissionRequest hook is set, Orca's included. */
export function permissionGuardSkipInUse(settings: GuardSkipSettings | null | undefined): boolean {
  return PERMISSION_GUARD_SKIP_AGENTS.some((agent) => guardSkipApplies(agent, settings))
}

/** What the Environment field shows and older clients receive: only the user's own entries. */
export function withoutPermissionGuardSkip<T extends object>(settings: T): T {
  return { ...settings, agentPermissionGuardSkip: {} }
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
