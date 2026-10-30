import type { TuiAgent } from './tui-agent'
import type { GlobalSettings } from './global-settings-types'
import { isTuiAgent } from './tui-agent-config'

// Match desktop catalog order: this determines fallback priority without a selected default.
export const TUI_AGENT_AUTO_PICK_ORDER = [
  'claude',
  'claude-agent-teams',
  'openclaude',
  'codex',
  'grok',
  'copilot',
  'opencode2',
  'opencode',
  'mimo-code',
  'ante',
  'trae',
  'muse',
  'dsh',
  'qoder',
  'qoder-cn',
  'zcode',
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
  'freebuff',
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
  'openclaw',
  'codebuddy',
  'jcode'
] as const satisfies readonly TuiAgent[]

// Fresh installs show Agent Teams; the migration separately preserves legacy hidden defaults.
export const DEFAULT_DISABLED_TUI_AGENTS = [] as const satisfies readonly TuiAgent[]

export function pickTuiAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  detected: Iterable<TuiAgent>,
  disabled?: Iterable<unknown> | null,
  chosenUsable?: (agent: TuiAgent) => boolean
): TuiAgent | null {
  if (preferred === 'blank') {
    return null
  }
  const disabledSet = new Set(normalizeDisabledTuiAgents(disabled))
  const detectedSet = detected instanceof Set ? detected : new Set(detected)
  if (
    preferred &&
    (detectedSet.has(preferred) || chosenUsable?.(preferred)) &&
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

export function buildAgentAvailabilitySettingsUpdate(
  settings: Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>,
  id: TuiAgent,
  enabled: boolean
): Pick<GlobalSettings, 'disabledTuiAgents'> & Partial<Pick<GlobalSettings, 'defaultTuiAgent'>> {
  const latestDisabled = normalizeDisabledTuiAgents(settings.disabledTuiAgents)
  const nextDisabled = enabled
    ? latestDisabled.filter((agent) => agent !== id)
    : latestDisabled.includes(id)
      ? latestDisabled
      : [...latestDisabled, id]

  return {
    disabledTuiAgents: nextDisabled,
    ...(settings.defaultTuiAgent === id && !enabled ? { defaultTuiAgent: null } : {})
  }
}

export function filterEnabledTuiAgents<T extends TuiAgent>(
  agents: Iterable<T>,
  disabled?: Iterable<unknown> | null
): T[] {
  const disabledSet = new Set(normalizeDisabledTuiAgents(disabled))
  return [...agents].filter((agent) => !disabledSet.has(agent))
}
