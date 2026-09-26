import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

export type AgentPermissionMode = 'yolo' | 'manual' | 'mixed'

export const YOLO_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--dangerously-skip-permissions',
  'claude-agent-teams': '--dangerously-skip-permissions',
  openclaude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  gemini: '--yolo',
  antigravity: '--dangerously-skip-permissions',
  aider: '--yes-always',
  amp: '--dangerously-allow-all',
  kiro: '--trust-all-tools',
  crush: '--yolo',
  autohand: '--unrestricted',
  cline: '--auto-approve true',
  'command-code': '--yolo',
  continue: '--allow "*"',
  cursor: '--yolo',
  kimi: '--yolo',
  muse: '--yolo',
  // Why: ZCode gates tools by collaboration mode; `yolo` is its bypass-everything mode.
  zcode: '--mode yolo',
  'mistral-vibe': '--agent auto-approve',
  'qwen-code': '--approval-mode yolo',
  rovo: '--yolo',
  hermes: '--yolo',
  copilot: '--yolo',
  grok: '--permission-mode bypassPermissions',
  devin: '--permission-mode bypass --respect-workspace-trust false',
  ante: '--yolo',
  trae: '--yolo',
  droid: '--auto high'
}

export const YOLO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'auto' }
}

const PERMISSION_AGENT_IDS = Object.keys(TUI_AGENT_CONFIG).filter(
  (agent): agent is TuiAgent => agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
)

/**
 * Trims launch arguments or returns an empty string if undefined/null.
 *
 * @param value - The argument string to normalize.
 * @returns The trimmed string or empty string.
 */
function normalizeArgs(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

/**
 * Compares two environment variable dictionaries for shallow equality.
 *
 * @param left - First environment map.
 * @param right - Second environment map.
 * @returns True if both records contain identical key-value pairs.
 */
function sameEnv(
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  if (leftEntries.length !== rightEntries.length) {
    return false
  }
  return leftEntries.every(([name, value]) => right?.[name] === value)
}

/**
 * Resolves the permission mode of an argument string against its YOLO counterpart.
 *
 * @param args - Configured argument string.
 * @param yoloArgs - Expected YOLO argument string for this agent.
 * @returns 'manual' if empty, 'yolo' if exact match, or 'mixed' if customized.
 */
function resolveAgentPermissionMode(args: string, yoloArgs: string): AgentPermissionMode {
  if (!args) {
    return 'manual'
  }
  return args === yoloArgs ? 'yolo' : 'mixed'
}

/**
 * Resolves the permission mode of an environment map against its YOLO counterpart.
 *
 * @param env - Configured environment map.
 * @param yoloEnv - Expected YOLO environment map for this agent.
 * @returns 'manual' if empty, 'yolo' if exact match, or 'mixed' if customized.
 */
function resolveAgentEnvPermissionMode(
  env: Record<string, string> | null | undefined,
  yoloEnv: Record<string, string> | undefined
): AgentPermissionMode {
  if (sameEnv(env, {})) {
    return 'manual'
  }
  return sameEnv(env, yoloEnv) ? 'yolo' : 'mixed'
}

/**
 * Combines an array of agent permission modes into an aggregate mode.
 *
 * @param modes - Array of resolved permission modes across evaluated agents.
 * @returns 'yolo' if all are YOLO, 'manual' if all are manual, or 'mixed' otherwise.
 */
function combinePermissionModes(modes: AgentPermissionMode[]): AgentPermissionMode {
  let sawYolo = false
  let sawManual = false
  let sawMixed = false

  for (const mode of modes) {
    if (mode === 'yolo') {
      sawYolo = true
    } else if (mode === 'manual') {
      sawManual = true
    } else {
      sawMixed = true
    }
  }

  if (sawMixed || (sawYolo && sawManual)) {
    return 'mixed'
  }
  return sawYolo ? 'yolo' : 'manual'
}

/**
 * Resolves the active permission mode for a single agent based on its arguments and environment.
 *
 * @param args - Object containing agent identifier, arguments, and environment variables.
 * @returns Resolved mode: 'yolo', 'manual', or 'mixed'.
 */
export function resolveTuiAgentPermissionMode(args: {
  agent: TuiAgent
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
}): AgentPermissionMode {
  const modes: AgentPermissionMode[] = []
  if (args.agent in YOLO_TUI_AGENT_ARGS) {
    modes.push(
      resolveAgentPermissionMode(
        normalizeArgs(args.agentArgs),
        YOLO_TUI_AGENT_ARGS[args.agent] ?? ''
      )
    )
  }
  if (args.agent in YOLO_TUI_AGENT_ENV) {
    modes.push(resolveAgentEnvPermissionMode(args.agentEnv, YOLO_TUI_AGENT_ENV[args.agent]))
  }

  return combinePermissionModes(modes)
}

/**
 * Resolves the overall permission mode across all known permission-capable agents.
 *
 * @param args - Configured default launch arguments and environment records.
 * @returns Aggregate mode: 'yolo', 'manual', or 'mixed'.
 */
export function resolveAgentPermissionModeSummary(args: {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): AgentPermissionMode {
  const modes: AgentPermissionMode[] = []

  for (const agent of PERMISSION_AGENT_IDS) {
    modes.push(
      resolveTuiAgentPermissionMode({
        agent,
        agentArgs: args.agentDefaultArgs?.[agent],
        agentEnv: args.agentDefaultEnv?.[agent]
      })
    )
  }

  return combinePermissionModes(modes)
}

/**
 * Resolves the overall agent permission mode summary considering only configured agents.
 *
 * Unlike {@link resolveAgentPermissionModeSummary}, this function ignores agents that are not
 * physically present in either `agentDefaultArgs` or `agentDefaultEnv`. It also allows excluding
 * specific agents via `excludeAgents` to evaluate the baseline posture of a profile.
 *
 * @param args - The configured default arguments, environment variables, and optional excluded agents.
 * @returns The resolved mode: `'yolo'` if all configured agents are YOLO, `'manual'` if all are manual or none configured, or `'mixed'`.
 */
export function resolveConfiguredAgentPermissionModeSummary(args: {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
  excludeAgents?: readonly TuiAgent[]
}): AgentPermissionMode {
  const modes: AgentPermissionMode[] = []
  const excluded = new Set(args.excludeAgents ?? [])

  for (const agent of PERMISSION_AGENT_IDS) {
    if (excluded.has(agent)) {
      continue
    }
    const hasArgs =
      args.agentDefaultArgs &&
      Object.hasOwn(args.agentDefaultArgs, agent) &&
      typeof args.agentDefaultArgs[agent] === 'string'
    const hasEnv =
      args.agentDefaultEnv &&
      Object.hasOwn(args.agentDefaultEnv, agent) &&
      typeof args.agentDefaultEnv[agent] === 'object' &&
      args.agentDefaultEnv[agent] !== null
    if (!hasArgs && !hasEnv) {
      continue
    }
    modes.push(
      resolveTuiAgentPermissionMode({
        agent,
        agentArgs: args.agentDefaultArgs?.[agent],
        agentEnv: args.agentDefaultEnv?.[agent]
      })
    )
  }

  if (modes.length === 0) {
    return 'manual'
  }
  return combinePermissionModes(modes)
}

/**
 * Applies a target permission mode ('yolo' or 'manual') to configured agent arguments and environment.
 *
 * @param args - Target mode and existing argument/environment records.
 * @returns Updated records with the target permission mode applied to untouched/defaulted agents.
 */
export function applyAgentPermissionMode(args: {
  mode: Exclude<AgentPermissionMode, 'mixed'>
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): {
  agentDefaultArgs: Partial<Record<TuiAgent, string>>
  agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>>
} {
  const nextArgs = { ...args.agentDefaultArgs }
  const nextEnv = { ...args.agentDefaultEnv }

  for (const agent of PERMISSION_AGENT_IDS) {
    if (agent in YOLO_TUI_AGENT_ARGS) {
      const yoloArgs = YOLO_TUI_AGENT_ARGS[agent] ?? ''
      const currentArgs = normalizeArgs(nextArgs[agent])
      if (!currentArgs || currentArgs === yoloArgs) {
        nextArgs[agent] = args.mode === 'yolo' ? yoloArgs : ''
      }
    }

    if (agent in YOLO_TUI_AGENT_ENV) {
      const yoloEnv = YOLO_TUI_AGENT_ENV[agent]
      const currentEnv = nextEnv[agent]
      if (sameEnv(currentEnv, {}) || sameEnv(currentEnv, yoloEnv)) {
        nextEnv[agent] = args.mode === 'yolo' ? { ...yoloEnv } : {}
      }
    }
  }

  return { agentDefaultArgs: nextArgs, agentDefaultEnv: nextEnv }
}
