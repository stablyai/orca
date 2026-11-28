import type { Translate } from '@/i18n/use-translate'
import type { BrowserExtensionFailure } from '../../../../../../shared/browser/extensions/browser-extension-types'

/**
 * Toast text for a failed extension action. Tagged failures are Orca's own copy, worded in the UI
 * language; untagged ones are provider or OS diagnostics, shown as main reported them.
 */
export function browserExtensionFailureMessage(
  t: Translate,
  result: { error: string; failure?: BrowserExtensionFailure }
): string {
  const failure = result.failure
  switch (failure?.reason) {
    case undefined:
      return result.error
    case 'support-disabled':
      return t(
        'settings.browser.extensions.failure.supportDisabled',
        'Turn on browser extensions in Settings › Browser › Extensions'
      )
    case 'invalid-web-store-input':
      return t(
        'settings.browser.extensions.failure.invalidWebStoreInput',
        'Paste a Chrome Web Store link or a 32-letter extension ID'
      )
    case 'profile-unavailable':
      return t(
        'settings.browser.extensions.failure.profileUnavailable',
        'Browser profile is not available for extensions'
      )
    case 'already-added':
      return t('settings.browser.extensions.failure.alreadyAdded', '{{name}} is already added', {
        name: failure.name
      })
  }
  return result.error
}
