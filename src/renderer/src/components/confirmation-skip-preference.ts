import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import type { GlobalSettings } from '../../../shared/types'

/** Persists the preference and keeps its reversal one click away. */
export function persistConfirmationSkipPreference({
  updates,
  settingsSectionId,
  updateSettings,
  openSettingsPage,
  openSettingsTarget
}: {
  updates: Partial<GlobalSettings>
  settingsSectionId: string
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  openSettingsPage: () => void
  openSettingsTarget: (target: {
    pane: SettingsNavTarget
    repoId: string | null
    sectionId?: string
  }) => void
}): void {
  void updateSettings(updates).then(
    () =>
      toast.success(
        translate(
          'auto.components.confirmation.skip.saved',
          "We'll skip this confirmation next time."
        ),
        {
          description: translate(
            'auto.components.confirmation.skip.savedDescription',
            'You can change this in Settings.'
          ),
          duration: 8000,
          action: {
            label: translate('auto.components.confirmation.skip.openSettings', 'Open Settings'),
            onClick: () => {
              openSettingsPage()
              openSettingsTarget({ pane: 'general', repoId: null, sectionId: settingsSectionId })
            }
          }
        }
      ),
    () =>
      toast.error(
        translate(
          'auto.components.confirmation.skip.preference.0b0cb6e3f9',
          'Could not save the confirmation preference.'
        )
      )
  )
}
