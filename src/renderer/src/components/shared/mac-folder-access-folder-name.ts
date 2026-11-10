import type { PtyManagementDaemonCwdClass } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/** Use the same macOS folder phrase in toast and remedy so they read as one notice. */
export function macFolderAccessFolderName(
  cwdClass: PtyManagementDaemonCwdClass,
  t: Translate = translate
): string {
  switch (cwdClass) {
    case 'documents':
      return t('auto.components.shared.macFolderAccessFolderName.documents', 'Documents folder')
    case 'desktop':
      return t('auto.components.shared.macFolderAccessFolderName.desktop', 'Desktop folder')
    case 'downloads':
      return t('auto.components.shared.macFolderAccessFolderName.downloads', 'Downloads folder')
    case 'other-home':
    case 'outside-home':
      return t('auto.components.shared.macFolderAccessFolderName.workspace', 'workspace folder')
  }
}
