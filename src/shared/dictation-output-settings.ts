import type { DictationOutputVolumeMode } from './speech-types'

export type DictationOutputCapabilities = {
  canMuteOutput: boolean
  canDuckOutput: boolean
  canPauseMedia: boolean
}

export type DictationOutputControlSettings = {
  pauseMedia: boolean
  volumeMode: DictationOutputVolumeMode
  duckedVolumePercent: number
}

export type DictationOutputSettingsInput = {
  pauseMediaOnDictation?: unknown
  outputVolumeMode?: unknown
  duckedVolumePercent?: unknown
}

export const DEFAULT_DUCKED_VOLUME_PERCENT = 20
export const DEFAULT_OUTPUT_VOLUME_MODE: DictationOutputVolumeMode = 'unchanged'

export function clampDuckedVolumePercent(value: unknown): number {
  const numericValue =
    typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DUCKED_VOLUME_PERCENT
  return Math.min(100, Math.max(0, Math.round(numericValue)))
}

export function normalizeDictationOutputVolumeMode(value: unknown): DictationOutputVolumeMode {
  return value === 'mute' || value === 'duck' || value === 'unchanged'
    ? value
    : DEFAULT_OUTPUT_VOLUME_MODE
}

export function normalizeDictationOutputSettings(input: DictationOutputSettingsInput) {
  return {
    pauseMediaOnDictation:
      typeof input.pauseMediaOnDictation === 'boolean' ? input.pauseMediaOnDictation : false,
    outputVolumeMode: normalizeDictationOutputVolumeMode(input.outputVolumeMode),
    duckedVolumePercent: clampDuckedVolumePercent(input.duckedVolumePercent)
  }
}

export function toDictationOutputControlSettings(
  input: DictationOutputSettingsInput
): DictationOutputControlSettings {
  const normalized = normalizeDictationOutputSettings(input)
  return {
    pauseMedia: normalized.pauseMediaOnDictation,
    volumeMode: normalized.outputVolumeMode,
    duckedVolumePercent: normalized.duckedVolumePercent
  }
}

export function isDictationOutputControlEnabled(settings: DictationOutputControlSettings): boolean {
  return settings.pauseMedia || settings.volumeMode !== 'unchanged'
}
