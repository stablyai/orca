import { translate } from '@/i18n/i18n'
import type { BrowserExtensionSource } from '../../../shared/browser-extension-types'

/** One wording for every remove prompt (Settings, toolbar, store page): Orca removes it everywhere. */
export function browserExtensionRemovalDescription(source: BrowserExtensionSource): string {
  return source === 'unpacked'
    ? translate(
        'settings.browser.extensions.removeUnpackedDescription',
        'It is removed from every Orca browser profile, with its saved data. The folder on disk stays where it is.'
      )
    : translate(
        'settings.browser.extensions.removeDescription',
        'It is removed from every Orca browser profile, with its saved data.'
      )
}
