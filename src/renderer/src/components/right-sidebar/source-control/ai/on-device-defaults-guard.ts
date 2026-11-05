import { translate } from '@/i18n/i18n'

/** A per-action recipe stores a CLI agent id, so the provider cannot be pinned per action. */
export function onDeviceSaveDefaultsMessage(): string {
  return translate(
    'sourceControl.onDeviceSaveDefaultsUnsupported',
    'On-device generation follows the agent chosen in Settings, so it cannot be saved as a per-action default. Pick a CLI agent to save this action.'
  )
}
