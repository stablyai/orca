import type { CatalogOption } from './agent-session-option-catalog'

export const PI_THINKING_LEVELS: readonly string[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const
const rank = (level: string): number => PI_THINKING_LEVELS.indexOf(level === 'none' ? 'off' : level)

export function catalogEffortLevels(controls: readonly CatalogOption[]): string[] | undefined {
  const effort = controls.find((option) => option.id === 'effort')
  return effort?.kind.type === 'select'
    ? effort.kind.choices.map((choice) => choice.value)
    : undefined
}

/** Pi uses higher-first, then lower; unknown support preserves opaque intent. */
export function effectiveAgentEffort(
  effort: string | undefined,
  supported: readonly string[] | undefined
): string | undefined {
  if (!effort || !supported?.length || supported.includes(effort) || rank(effort) === -1) {
    return effort
  }
  const ranked = supported.filter((level) => rank(level) !== -1).sort((a, b) => rank(a) - rank(b))
  return ranked.find((level) => rank(level) >= rank(effort)) ?? ranked.at(-1) ?? effort
}
