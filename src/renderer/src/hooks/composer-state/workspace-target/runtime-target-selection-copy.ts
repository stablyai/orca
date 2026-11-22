import { translate } from '@/i18n/i18n'

/** Withheld-platform reason shown while the composer has no project selected. */
export function selectProjectFirstReason(): string {
  return translate(
    'auto.hooks.composerState.runtimeTargetSelection.selectProjectFirst',
    'Select a project first.'
  )
}
