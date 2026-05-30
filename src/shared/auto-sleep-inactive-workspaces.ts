export const AUTO_SLEEP_INACTIVE_WORKSPACE_PRESETS = [
  { value: 'off', label: 'Off', ms: null },
  { value: '30m', label: '30 minutes', ms: 30 * 60_000 },
  { value: '1h', label: '1 hour', ms: 60 * 60_000 },
  { value: '4h', label: '4 hours', ms: 4 * 60 * 60_000 }
] as const

export type AutoSleepInactiveWorkspacePresetValue =
  (typeof AUTO_SLEEP_INACTIVE_WORKSPACE_PRESETS)[number]['value']

export function autoSleepPresetValueFromMs(
  ms: number | null | undefined
): AutoSleepInactiveWorkspacePresetValue {
  if (ms == null) {
    return 'off'
  }
  const exact = AUTO_SLEEP_INACTIVE_WORKSPACE_PRESETS.find((preset) => preset.ms === ms)
  return exact ? exact.value : 'off'
}

export function autoSleepMsFromPresetValue(value: string): number | null {
  const preset = AUTO_SLEEP_INACTIVE_WORKSPACE_PRESETS.find((entry) => entry.value === value)
  return preset?.ms ?? null
}
