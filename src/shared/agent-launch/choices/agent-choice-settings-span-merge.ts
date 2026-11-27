import { quoteStartupArg, type AgentStartupShell } from '../startup/tui-agent-startup-shell'
import type { ChoiceOccurrence } from './agent-launch-choices'

type CutRange = Pick<ChoiceOccurrence, 'start' | 'end' | 'replacement' | 'settings'>

export function settingsWithoutKeys(
  settings: NonNullable<ChoiceOccurrence['settings']>,
  shell: AgentStartupShell
): string {
  const remaining = Object.fromEntries(
    Object.entries(settings.json).filter(([key]) => !settings.keys.includes(key))
  )
  return `${settings.name} ${quoteStartupArg(JSON.stringify(remaining), shell)}`
}

/** Options carried by one settings JSON share its span; cutting them together drops all their keys. */
export function mergeSharedSettingsRanges<T extends CutRange>(
  sorted: readonly T[],
  shell: AgentStartupShell
): T[] {
  const merged: T[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (
      previous?.settings &&
      range.settings &&
      previous.start === range.start &&
      previous.end === range.end
    ) {
      const settings = {
        ...previous.settings,
        keys: [...previous.settings.keys, ...range.settings.keys]
      }
      merged[merged.length - 1] = {
        ...previous,
        settings,
        replacement: settingsWithoutKeys(settings, shell)
      }
    } else {
      merged.push(range)
    }
  }
  return merged
}
