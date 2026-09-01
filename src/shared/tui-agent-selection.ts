import type { BuiltInTuiAgent, TuiAgent } from './types'
import { isTuiAgent } from './tui-agent-config'

// Keep this order in sync with the desktop agent catalog. It defines the
// automatic fallback priority for the Auto default. Auto never selects a
// custom agent, so this list stays built-in-only.
export const TUI_AGENT_AUTO_PICK_ORDER = [
  'claude',
  'claude-agent-teams',
  'openclaude',
  'codex',
  'grok',
  'copilot',
  'opencode',
  'mimo-code',
  'ante',
  'trae',
  'pi',
  'omp',
  'prime-agent',
  'gemini',
  'antigravity',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro',
  'crush',
  'aug',
  'autohand',
  'cline',
  'codebuff',
  'command-code',
  'continue',
  'cursor',
  'droid',
  'kimi',
  'mistral-vibe',
  'qwen-code',
  'rovo',
  'hermes',
  'devin',
  'openclaw'
] as const satisfies readonly BuiltInTuiAgent[]

// Why: fresh installs should expose Claude Agent Teams in agent pickers; the
// persistence migration separately preserves the old hidden default for legacy profiles.
export const DEFAULT_DISABLED_TUI_AGENTS = [] as const satisfies readonly TuiAgent[]

export function pickTuiAgent(
  preferred: TuiAgent | 'auto' | 'blank' | null | undefined,
  detected: Iterable<TuiAgent>,
  disabled?: Iterable<unknown> | null
): TuiAgent | null {
  if (preferred === 'blank') {
    return null
  }
  const disabledSet = new Set(normalizeDisabledTuiAgents(disabled))
  const detectedSet = detected instanceof Set ? detected : new Set(detected)
  if (
    preferred &&
    // Why: 'auto' is the migrated spelling of the legacy null Auto default and must
    // take the auto-pick path, never be looked up as a concrete agent id.
    preferred !== 'auto' &&
    detectedSet.has(preferred) &&
    !disabledSet.has(preferred)
  ) {
    return preferred
  }
  for (const agent of TUI_AGENT_AUTO_PICK_ORDER) {
    if (detectedSet.has(agent) && !disabledSet.has(agent)) {
      return agent
    }
  }
  return null
}

/** Interim adapter for surfaces still written against the pre-v1 default shape,
 *  where `null` meant Auto. Maps the migrated `'auto'` back to that legacy `null`
 *  so shipped Auto behavior is preserved until the U2 resolver and U8 UI replace
 *  these call sites with explicit Auto/Blank/repair states. */
export function toLegacyAutoPreference(
  value: TuiAgent | 'auto' | 'blank' | null | undefined
): TuiAgent | 'blank' | null {
  // Undefined is a pre-v1 profile that never migrated, where absent meant Auto.
  if (value === 'auto' || value === undefined) {
    return null
  }
  // Post-migration `null` is a repaired/cleared default (delete `clear`, or a
  // base disable repairing its derivatives). Mapping it to the legacy Auto null
  // would auto-pick whatever agent happens to be installed, so it stays an
  // explicit "no agent" instead.
  if (value === null) {
    return 'blank'
  }
  return value
}

export function normalizeDisabledTuiAgents(value: unknown): TuiAgent[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<TuiAgent>()
  for (const item of value) {
    if (isTuiAgent(item)) {
      seen.add(item)
    }
  }
  return [...seen]
}

export function haveSameDisabledTuiAgents(left: unknown, right: unknown): boolean {
  const leftSet = new Set(normalizeDisabledTuiAgents(left))
  const rightSet = new Set(normalizeDisabledTuiAgents(right))
  return leftSet.size === rightSet.size && [...leftSet].every((agent) => rightSet.has(agent))
}

export function isTuiAgentEnabled(agent: TuiAgent, disabled?: Iterable<unknown> | null): boolean {
  return !normalizeDisabledTuiAgents(disabled).includes(agent)
}

export function filterEnabledTuiAgents<T extends TuiAgent>(
  agents: Iterable<T>,
  disabled?: Iterable<unknown> | null
): T[] {
  const disabledSet = new Set(normalizeDisabledTuiAgents(disabled))
  return [...agents].filter((agent) => !disabledSet.has(agent))
}
