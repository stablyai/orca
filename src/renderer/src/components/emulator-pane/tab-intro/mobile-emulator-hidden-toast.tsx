import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

const MOBILE_EMULATOR_HIDDEN_TOAST_ID = 'mobile-emulator-hidden'

export function showMobileEmulatorHiddenToast({ undo }: { undo: () => void }): void {
  toast.info(
    translate('emulatorPane.tabIntro.hiddenFromMenu', 'Mobile Emulator removed from the + menu'),
    {
      id: MOBILE_EMULATOR_HIDDEN_TOAST_ID,
      description: translate(
        'emulatorPane.tabIntro.hiddenFromMenuHint',
        'Bring it back from the gear at the end of the icon row.'
      ),
      action: {
        label: translate('emulatorPane.tabIntro.undoHide', 'Undo'),
        onClick: undo
      },
      dismissible: true
    }
  )
}
