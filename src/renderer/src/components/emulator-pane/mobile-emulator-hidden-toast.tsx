import { toast } from 'sonner'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'

const MOBILE_EMULATOR_HIDDEN_TOAST_ID = 'mobile-emulator-hidden'

type MobileEmulatorHiddenToastDeps = {
  openSettingsPage: AppState['openSettingsPage']
  openSettingsTarget: AppState['openSettingsTarget']
}

export function showMobileEmulatorHiddenToast(deps: MobileEmulatorHiddenToastDeps): void {
  // Why: matches other one-time opt-out nudges — stay on screen until the user
  // dismisses it so the Settings re-enable path is easy to find.
  toast.info(
    translate(
      'auto.components.emulator.pane.mobile.emulator.hidden.toast.e8f098a870',
      'Mobile Emulator hidden'
    ),
    {
      id: MOBILE_EMULATOR_HIDDEN_TOAST_ID,
      description: (
        <p className="text-sm text-popover-foreground/80">
          {translate(
            'auto.components.emulator.pane.mobile.emulator.hidden.toast.c46c979c1d',
            'Re-enable Mobile Emulator anytime in'
          )}{' '}
          <button
            type="button"
            onClick={() => {
              deps.openSettingsTarget({ pane: 'mobile-emulator', repoId: null })
              deps.openSettingsPage()
              toast.dismiss(MOBILE_EMULATOR_HIDDEN_TOAST_ID)
            }}
            className="cursor-pointer font-medium text-popover-foreground underline underline-offset-2 hover:text-primary"
          >
            {translate(
              'auto.components.emulator.pane.mobile.emulator.hidden.toast.600f9a745a',
              'Settings › Mobile Emulator'
            )}
          </button>
          .
        </p>
      ),
      duration: Infinity,
      dismissible: true
    }
  )
}
