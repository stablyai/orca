import type { GlobalSettings } from '../global-settings-types'
import {
  normalizePluginThemeSettings,
  type PluginThemeSettingsInput
} from '../plugin-theme-settings'
import {
  normalizePluginFileTypeSuggestionSettings,
  type PluginFileTypeSuggestionSettingsInput
} from './plugin-file-type'

type PluginOwnedSettingsInput = PluginThemeSettingsInput & PluginFileTypeSuggestionSettingsInput

/** Bounds every setting that plugins or plugin UI write; only keys present in `input` return. */
export function normalizePluginOwnedSettings(
  input: PluginOwnedSettingsInput
): Partial<GlobalSettings> {
  return {
    ...normalizePluginThemeSettings(input),
    ...normalizePluginFileTypeSuggestionSettings(input)
  }
}
