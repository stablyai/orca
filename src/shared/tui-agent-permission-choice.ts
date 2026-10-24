import { agentChatPermissionModes } from './agent-chat-permission-support'
import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  AUTO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from './tui-agent-permissions'
import type { TuiAgent } from './tui-agent'

/**
 * An agent's stored permission. `own`: Orca adds no permission flag and the agent's own config
 * applies. The rest use the chat's four modes. Saved in settings: never rename a value.
 */
export type AgentPermissionChoice = 'own' | AgentChatPermissionMode

export const AGENT_PERMISSION_CHOICES = [
  'own',
  'ask',
  'accept-edits',
  'auto',
  'full-access'
] as const satisfies readonly AgentPermissionChoice[]

export type AgentPermissionGlobalSettings = {
  /** Every agent's permission in terminals and new chats, unless it has its own below. Absent on
   *  profiles saved before permissions were stored apart from Arguments. */
  agentPermissionDefault?: AgentPermissionChoice
  /** Agents given their own permission instead of the all-agents one. */
  agentPermissionOverrides?: Partial<Record<TuiAgent, AgentPermissionChoice>>
}

export function isAgentPermissionChoice(value: unknown): value is AgentPermissionChoice {
  return AGENT_PERMISSION_CHOICES.some((choice) => choice === value)
}

// Why only these: each recipe is verified against its CLI. Ask states every field Orca's own Ask
// chat states (Codex: approvals, sandbox and reviewer), so an agent's config can't widen it.
const ASK_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--permission-mode default',
  'claude-agent-teams': '--permission-mode default',
  grok: '--permission-mode default',
  codex: '-a on-request -s workspace-write -c approvals_reviewer=user'
}

const ACCEPT_EDITS_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--permission-mode acceptEdits',
  'claude-agent-teams': '--permission-mode acceptEdits'
}

const ARGS_BY_CHOICE: Record<AgentChatPermissionMode, Partial<Record<TuiAgent, string>>> = {
  ask: ASK_TUI_AGENT_ARGS,
  'accept-edits': ACCEPT_EDITS_TUI_AGENT_ARGS,
  auto: AUTO_TUI_AGENT_ARGS,
  'full-access': YOLO_TUI_AGENT_ARGS
}

/** The flag text Orca adds for this choice; empty for `own` or a choice the agent lacks. */
export function agentPermissionArgs(agent: TuiAgent, choice: AgentPermissionChoice): string {
  return choice === 'own' ? '' : (ARGS_BY_CHOICE[choice][agent] ?? '')
}

/** The environment Orca adds for this choice (Goose's bypass is an env var). */
export function agentPermissionEnv(
  agent: TuiAgent,
  choice: AgentPermissionChoice
): Record<string, string> {
  return choice === 'full-access' ? { ...YOLO_TUI_AGENT_ENV[agent] } : {}
}

function supportsChoice(agent: TuiAgent, choice: AgentPermissionChoice): boolean {
  return (
    choice === 'own' ||
    agentPermissionArgs(agent, choice) !== '' ||
    Object.keys(agentPermissionEnv(agent, choice)).length > 0 ||
    agentChatPermissionModes(agent)?.modes.includes(choice) === true
  )
}

/** Modes supported by at least one of this agent's terminal or chat surfaces. */
export function agentPermissionChoices(agent: TuiAgent): readonly AgentPermissionChoice[] {
  return AGENT_PERMISSION_CHOICES.filter((choice) => supportsChoice(agent, choice))
}

/** Agents with at least one terminal or chat mode beyond `own`, in catalog order. */
export const PERMISSION_CHOICE_AGENTS: readonly TuiAgent[] = Object.keys(TUI_AGENT_CONFIG).filter(
  (agent): agent is TuiAgent => isTuiAgent(agent) && agentPermissionChoices(agent).length > 1
)

export type AgentPermissionSettings = AgentPermissionGlobalSettings

/** Settings that store the permission as a choice rather than as flag text in Arguments. */
export function hasTypedAgentPermission(settings: AgentPermissionSettings | null | undefined) {
  return isAgentPermissionChoice(settings?.agentPermissionDefault)
}

/**
 * Reads stored intent. Each consuming surface applies its own supported-mode rules.
 */
export function resolveAgentPermission(
  agent: TuiAgent,
  settings: AgentPermissionSettings | null | undefined
): { choice: AgentPermissionChoice; source: 'agent' | 'all' } {
  const override = settings?.agentPermissionOverrides?.[agent]
  if (isAgentPermissionChoice(override)) {
    return { choice: override, source: 'agent' }
  }
  const fallback = settings?.agentPermissionDefault
  const choice = isAgentPermissionChoice(fallback) ? fallback : 'own'
  return { choice, source: 'all' }
}

export function normalizeAgentPermissionOverrides(
  value: unknown
): NonNullable<AgentPermissionGlobalSettings['agentPermissionOverrides']> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([agent, choice]) => isTuiAgent(agent) && isAgentPermissionChoice(choice)
    )
  )
}

/**
 * The all-agents choice applied: every agent follows it, except that Auto leaves agents without
 * it on what they had, as the Auto switch always has (falling to `own` could widen or narrow them).
 */
export function applyAllAgentsPermission(
  settings: AgentPermissionSettings,
  choice: AgentPermissionChoice
): Required<AgentPermissionSettings> {
  const overrides: Partial<Record<TuiAgent, AgentPermissionChoice>> = {}
  if (choice === 'auto') {
    for (const agent of PERMISSION_CHOICE_AGENTS) {
      const previous = resolveAgentPermission(agent, settings).choice
      if (!supportsChoice(agent, 'auto')) {
        overrides[agent] = previous
      }
    }
  }
  return { agentPermissionDefault: choice, agentPermissionOverrides: overrides }
}

/** Sets agents' own choices; `'default'` makes them follow the all-agents choice again. */
export function applyAgentPermissionOverrides(
  settings: AgentPermissionSettings,
  agents: readonly TuiAgent[],
  choice: AgentPermissionChoice | 'default'
): Pick<AgentPermissionGlobalSettings, 'agentPermissionOverrides'> {
  const overrides = { ...settings.agentPermissionOverrides }
  for (const agent of agents) {
    if (choice === 'default') {
      delete overrides[agent]
    } else {
      overrides[agent] = choice
    }
  }
  return { agentPermissionOverrides: overrides }
}

/** Normalizes the stored permission in a settings write. An unknown all-agents choice is dropped:
 *  saved, it would read as legacy text and lose every agent's stored permission. */
export function sanitizeAgentPermissionUpdates(
  target: AgentPermissionGlobalSettings,
  updates: AgentPermissionGlobalSettings
): void {
  if (
    'agentPermissionDefault' in updates &&
    !isAgentPermissionChoice(updates.agentPermissionDefault)
  ) {
    delete target.agentPermissionDefault
  }
  if ('agentPermissionOverrides' in updates) {
    target.agentPermissionOverrides = normalizeAgentPermissionOverrides(
      updates.agentPermissionOverrides
    )
  }
}
