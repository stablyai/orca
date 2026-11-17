import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  browserExtensionHostWarning,
  browserExtensionPermissionWarning,
  type BrowserExtensionPermissionWarning
} from '../../../shared/browser/extensions/browser-extension-permission-warnings'
import {
  unsupportedBrowserExtensionFeatures,
  type UnsupportedBrowserExtensionFeature
} from '../../../shared/browser/extensions/browser-extension-unsupported-features'

/** Plain-language wording for the shared warning rules (browser-extension-permission-warnings). */

const MAX_NAMED_HOSTS = 3

function permissionMessage(
  warning: BrowserExtensionPermissionWarning,
  t: Translate = translate
): string {
  switch (warning) {
    case 'history':
      return t('browserExtensions.permission.history', 'Read your browsing history')
    case 'historyWrite':
      return t('browserExtensions.permission.historyWrite', 'Read and change your browsing history')
    case 'bookmarks':
      return t('browserExtensions.permission.bookmarks', 'Read and change your bookmarks')
    case 'clipboardRead':
      return t('browserExtensions.permission.clipboardRead', 'Read data you copy and paste')
    case 'clipboardWrite':
      return t('browserExtensions.permission.clipboardWrite', 'Modify data you copy and paste')
    case 'downloads':
      return t('browserExtensions.permission.downloads', 'Manage your downloads')
    case 'nativeMessaging':
      return t(
        'browserExtensions.permission.nativeMessaging',
        'Communicate with cooperating native applications'
      )
    case 'notifications':
      return t('browserExtensions.permission.notifications', 'Display notifications')
    case 'privacy':
      return t('browserExtensions.permission.privacy', 'Change your privacy-related settings')
    case 'management':
      return t('browserExtensions.permission.management', 'Manage your other extensions')
    case 'proxy':
      return t('browserExtensions.permission.proxy', 'Change your proxy settings')
    case 'contentSettings':
      return t(
        'browserExtensions.permission.contentSettings',
        'Change which sites can use cookies, JavaScript, your camera, microphone and location'
      )
    case 'geolocation':
      return t('browserExtensions.permission.geolocation', 'Detect your physical location')
    case 'topSites':
      return t(
        'browserExtensions.permission.topSites',
        'Read a list of your most frequently visited websites'
      )
    case 'blockContent':
      return t('browserExtensions.permission.blockContent', 'Block content on any page')
    case 'debugger':
      return t('browserExtensions.permission.debugger', 'Access the page debugger backend')
    case 'screenCapture':
      return t('browserExtensions.permission.screenCapture', 'Capture content of your screen')
    case 'email':
      return t('browserExtensions.permission.email', 'Know your email address')
  }
}

function hostMessage(hostPermissions: string[], t: Translate = translate): string | null {
  const warning = browserExtensionHostWarning(hostPermissions)
  if (!warning) {
    return null
  }
  if (warning.kind === 'allSites') {
    return t(
      'browserExtensions.permission.allSites',
      'Read and change all your data on all websites'
    )
  }
  const { hosts } = warning
  if (hosts.length <= MAX_NAMED_HOSTS) {
    return t('browserExtensions.permission.someSites', 'Read and change your data on {{hosts}}', {
      hosts: hosts.join(', ')
    })
  }
  const named = hosts.slice(0, MAX_NAMED_HOSTS).join(', ')
  const count = hosts.length - MAX_NAMED_HOSTS
  return t(
    'browserExtensions.permission.manyOtherSites',
    'Read and change your data on {{hosts}} and {{count}} other sites',
    {
      hosts: named,
      count,
      defaultValue_one: 'Read and change your data on {{hosts}} and {{count}} other site'
    }
  )
}

/** Why skip unsupported ones: "It can" must not promise what Orca does not do; they get their own line. */
export function describeBrowserExtensionAccess(
  permissions: string[],
  hostPermissions: string[],
  t?: Translate
): string[] {
  const messages = [
    hostMessage(hostPermissions, t),
    ...permissions
      .filter((permission) => unsupportedBrowserExtensionFeatures([permission]).length === 0)
      .map(browserExtensionPermissionWarning)
      .map((warning) => (warning ? permissionMessage(warning, t) : null))
  ]
  return [...new Set(messages.filter((message): message is string => message !== null))]
}

function featureLabel(feature: UnsupportedBrowserExtensionFeature): string {
  switch (feature) {
    case 'identity':
      return translate('browserExtensions.unsupported.identity', 'extension sign-in')
  }
}

/** One calm line naming what the extension asks for that Orca cannot do yet, or null. */
export function describeUnsupportedBrowserExtensionFeatures(
  permissions: string[],
  t: Translate = translate
): string | null {
  const features = unsupportedBrowserExtensionFeatures(permissions)
  if (features.length === 0) {
    return null
  }
  return t('browserExtensions.unsupported.line', 'Not available in Orca yet: {{features}}.', {
    features: features.map(featureLabel).join(', ')
  })
}
