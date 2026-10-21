import type { PtyManagementDaemonCwdClass } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'

/**
 * The folder phrase the toast and the fix dialog both drop into "your {{folder}}", so the two read
 * as one notice. Only the three protected classes have a name macOS itself uses.
 */
export function macFolderAccessFolderName(cwdClass: PtyManagementDaemonCwdClass): string {
  switch (cwdClass) {
    case 'documents':
      return translate(
        'auto.components.shared.macFolderAccessFolderName.documents',
        'Documents folder'
      )
    case 'desktop':
      return translate('auto.components.shared.macFolderAccessFolderName.desktop', 'Desktop folder')
    case 'downloads':
      return translate(
        'auto.components.shared.macFolderAccessFolderName.downloads',
        'Downloads folder'
      )
    case 'other-home':
    case 'outside-home':
      return translate(
        'auto.components.shared.macFolderAccessFolderName.workspace',
        'workspace folder'
      )
  }
}
