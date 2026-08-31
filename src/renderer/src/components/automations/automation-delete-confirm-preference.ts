import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/**
 * Turning off the delete confirmation is a one-click, easily regretted change,
 * so the acknowledgement carries the way back to it rather than just reporting
 * success.
 */

export type AutomationDeleteConfirmPreferenceActions = {
  updateSettings: (update: { skipDeleteAutomationConfirm: boolean }) => unknown
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: 'general'; repoId: null; sectionId: string }) => void
}

export function persistSkipDeleteAutomationConfirm(
  actions: AutomationDeleteConfirmPreferenceActions
): void {
  void actions.updateSettings({ skipDeleteAutomationConfirm: true })
  toast.success(
    translate(
      'auto.components.automations.AutomationsPage.690b94da54',
      "We'll skip this confirmation next time."
    ),
    {
      description: translate(
        'auto.components.automations.AutomationsPage.d2a01b0b6f',
        'You can change this in Settings.'
      ),
      duration: 8000,
      action: {
        label: translate('auto.components.automations.AutomationsPage.8a3226f172', 'Open Settings'),
        onClick: () => {
          actions.openSettingsPage()
          actions.openSettingsTarget({
            pane: 'general',
            repoId: null,
            sectionId: 'general-skip-delete-automation-confirm'
          })
        }
      }
    }
  )
}
