import type { TuiAgent } from './tui-agent'

/**
 * Agents that can make an INTERACTIVE terminal genuinely ephemeral via a native flag, mapped to
 * that flag. Orca's own "incognito" only suppresses Orca's own scrollback; a harness that records
 * its own session (e.g. Claude Code writing ~/.claude/projects) keeps doing so unless it is
 * launched with a self-record-suppressing flag. Only list an agent here when its flag actually
 * works for interactive use — otherwise an "incognito" toggle would be a false privacy promise.
 *
 * Excluded on purpose:
 *  - claude: has `--no-session-persistence`, but its own help says it only works with `--print`,
 *    so it cannot make an interactive terminal ephemeral.
 *  - codex, gemini, opencode, goose, amp, droid, ...: no native no-record flag at all.
 * Extend this map as harnesses gain interactive ephemeral flags.
 */
export const INCOGNITO_CAPABLE_AGENTS: Partial<Record<TuiAgent, string>> = {
  pi: '--no-session', // Pi: "Don't save session, ephemeral" — verified interactive.
  omp: '--no-session' // OMP shares Pi's engine and flag.
}

/** True when the agent can be launched as a genuinely ephemeral interactive terminal. */
export function isIncognitoCapable(agent: TuiAgent | null | undefined): agent is TuiAgent {
  return agent != null && INCOGNITO_CAPABLE_AGENTS[agent] !== undefined
}

/**
 * Whether a launch of `agent` should be incognito by the per-agent default: the agent is
 * incognito-capable AND listed in Settings.terminalIncognitoAgents. This is the single rule every
 * launch builder uses so `applyIncognitoLaunchFlag` fires on all of them (the flag itself is also
 * capability-gated, so a stale non-capable entry can never add a flag the harness lacks).
 */
export function agentDefaultsToIncognito(
  agent: TuiAgent | null | undefined,
  terminalIncognitoAgents: readonly TuiAgent[] | null | undefined
): boolean {
  return (
    isIncognitoCapable(agent) &&
    Array.isArray(terminalIncognitoAgents) &&
    terminalIncognitoAgents.includes(agent)
  )
}

/** The native ephemeral flag for the agent, or undefined when it has none. */
export function incognitoFlagForAgent(agent: TuiAgent | null | undefined): string | undefined {
  return agent == null ? undefined : INCOGNITO_CAPABLE_AGENTS[agent]
}

/**
 * Appends the agent's native incognito flag to its launch args when incognito is on and the agent
 * is capable. Dedup-safe: a flag already present (e.g. a user-configured arg) is not doubled. For
 * non-capable agents the args are returned unchanged — Orca never adds a flag the harness lacks.
 */
export function applyIncognitoLaunchFlag(
  agent: TuiAgent,
  args: string,
  incognito: boolean
): string {
  if (!incognito) {
    return args
  }
  const flag = INCOGNITO_CAPABLE_AGENTS[agent]
  if (!flag) {
    return args
  }
  const tokens = args.split(/\s+/).filter(Boolean)
  if (tokens.includes(flag)) {
    return args
  }
  return args ? `${args} ${flag}` : flag
}
