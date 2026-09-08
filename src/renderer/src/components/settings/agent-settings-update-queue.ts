import type { GlobalSettings } from '../../../../shared/global-settings-types'

export type AgentSettingsUpdateOptions = {
  getSettings: () => GlobalSettings | null | undefined
  fallbackSettings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  buildUpdate: (settings: GlobalSettings) => Partial<GlobalSettings>
}

export function createAgentSettingsUpdateQueue(): (
  options: AgentSettingsUpdateOptions
) => Promise<void> {
  let pending: Promise<void> = Promise.resolve()
  return ({ getSettings, fallbackSettings, updateSettings, buildUpdate }) => {
    // Whole-map replacements must wait for the previous write's reconciled settings.
    pending = pending
      .catch(() => {})
      .then(async () => {
        await updateSettings(buildUpdate(getSettings() ?? fallbackSettings))
      })
    return pending
  }
}
