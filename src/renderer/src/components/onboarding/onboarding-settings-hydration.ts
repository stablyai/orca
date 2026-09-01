import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { toLegacyAutoPreference } from '../../../../shared/tui-agent-selection'

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

  // 'auto' (migrated legacy null) selects no fixed agent for onboarding hydration.
  const normalizedDefaultAgent = toLegacyAutoPreference(settings.defaultTuiAgent)
  const settingsAgent =
    normalizedDefaultAgent && normalizedDefaultAgent !== 'blank' ? normalizedDefaultAgent : null
  if (!agentInteracted && settingsAgent !== null && currentAgent !== settingsAgent) {
    update.selectedAgent = settingsAgent
  }

  return update
}
