import { toast } from 'sonner'
import type { WslHostWindowsDriveRefusal } from '../../../shared/wsl-host-windows-drive-refusal'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function wslHostWindowsDriveRefusalCopy(
  refusal: WslHostWindowsDriveRefusal,
  t: Translate = translate
): {
  title: string
  description: string
} {
  return {
    title: t(
      'auto.lib.wslHostWindowsDriveRefusal.title',
      'Add Windows drive folders on this computer'
    ),
    description: refusal.windowsPath
      ? t(
          'auto.lib.wslHostWindowsDriveRefusal.descriptionWithPath',
          '{{value0}} is on a Windows drive. Git in WSL reports false line-ending changes there, misses edits made from Windows, and searches it slowly.',
          { value0: refusal.windowsPath }
        )
      : t(
          'auto.lib.wslHostWindowsDriveRefusal.description',
          'This folder is on a Windows drive. Git in WSL reports false line-ending changes there, misses edits made from Windows, and searches it slowly.'
        )
  }
}

export function addOnThisComputerLabel(t: Translate = translate): string {
  return t('auto.lib.wslHostWindowsDriveRefusal.addOnThisComputer', 'Add on this computer')
}

/** Outside the Add Project dialog; inside it the refusal is inline, since toasts above a modal take no clicks. */
export function showWslHostWindowsDriveRefusal(refusal: WslHostWindowsDriveRefusal): void {
  const { title, description } = wslHostWindowsDriveRefusalCopy(refusal)
  toast.error(title, { description })
}
