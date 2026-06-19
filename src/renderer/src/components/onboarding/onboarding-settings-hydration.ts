import type { GlobalSettings, TuiAgent } from '../../../../shared/types'

export type OnboardingSettingsHydrationUpdate = {
  settingsHydrated: boolean
  theme?: GlobalSettings['theme']
  selectedAgent?: TuiAgent
}

export function resolveOnboardingSettingsHydration({
  settings,
  settingsHydrated,
  themeInteracted,
  agentInteracted,
  currentTheme,
  currentAgent
}: {
  settings: GlobalSettings | null
  settingsHydrated: boolean
  themeInteracted: boolean
  agentInteracted: boolean
  currentTheme: GlobalSettings['theme']
  currentAgent: TuiAgent | null
}): OnboardingSettingsHydrationUpdate | null {
  if (!settings || settingsHydrated) {
    return null
  }

  const update: OnboardingSettingsHydrationUpdate = {
    settingsHydrated: true
  }

  if (!themeInteracted && currentTheme !== settings.theme) {
    update.theme = settings.theme
  }

  const settingsAgent =
    settings.defaultTuiAgent && settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : null
  if (!agentInteracted && settingsAgent !== null && currentAgent !== settingsAgent) {
    update.selectedAgent = settingsAgent
  }

  return update
}
