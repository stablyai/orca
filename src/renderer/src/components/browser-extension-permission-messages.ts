import { translate } from '@/i18n/i18n'
import {
  browserExtensionHostWarning,
  browserExtensionPermissionWarning,
  type BrowserExtensionPermissionWarning
} from '../../../shared/browser-extension-permission-warnings'
import {
  unsupportedBrowserExtensionFeatures,
  type UnsupportedBrowserExtensionFeature
} from '../../../shared/browser-extension-unsupported-features'

/** Plain-language wording for the shared warning rules (browser-extension-permission-warnings). */

const MAX_NAMED_HOSTS = 3

function permissionMessage(warning: BrowserExtensionPermissionWarning): string {
  switch (warning) {
    case 'history':
      return translate('browserExtensions.permission.history', 'Read your browsing history')
    case 'historyWrite':
      return translate(
        'browserExtensions.permission.historyWrite',
        'Read and change your browsing history'
      )
    case 'bookmarks':
      return translate('browserExtensions.permission.bookmarks', 'Read and change your bookmarks')
    case 'clipboardRead':
      return translate('browserExtensions.permission.clipboardRead', 'Read data you copy and paste')
    case 'clipboardWrite':
      return translate(
        'browserExtensions.permission.clipboardWrite',
        'Modify data you copy and paste'
      )
    case 'downloads':
      return translate('browserExtensions.permission.downloads', 'Manage your downloads')
    case 'nativeMessaging':
      return translate(
        'browserExtensions.permission.nativeMessaging',
        'Communicate with cooperating native applications'
      )
    case 'notifications':
      return translate('browserExtensions.permission.notifications', 'Display notifications')
    case 'privacy':
      return translate(
        'browserExtensions.permission.privacy',
        'Change your privacy-related settings'
      )
    case 'management':
      return translate('browserExtensions.permission.management', 'Manage your other extensions')
    case 'proxy':
      return translate('browserExtensions.permission.proxy', 'Change your proxy settings')
    case 'contentSettings':
      return translate(
        'browserExtensions.permission.contentSettings',
        'Change which sites can use cookies, JavaScript, your camera, microphone and location'
      )
    case 'geolocation':
      return translate('browserExtensions.permission.geolocation', 'Detect your physical location')
    case 'topSites':
      return translate(
        'browserExtensions.permission.topSites',
        'Read a list of your most frequently visited websites'
      )
    case 'blockContent':
      return translate('browserExtensions.permission.blockContent', 'Block content on any page')
    case 'debugger':
      return translate('browserExtensions.permission.debugger', 'Access the page debugger backend')
    case 'screenCapture':
      return translate(
        'browserExtensions.permission.screenCapture',
        'Capture content of your screen'
      )
    case 'email':
      return translate('browserExtensions.permission.email', 'Know your email address')
  }
}

function hostMessage(hostPermissions: string[]): string | null {
  const warning = browserExtensionHostWarning(hostPermissions)
  if (!warning) {
    return null
  }
  if (warning.kind === 'allSites') {
    return translate(
      'browserExtensions.permission.allSites',
      'Read and change all your data on all websites'
    )
  }
  const { hosts } = warning
  if (hosts.length <= MAX_NAMED_HOSTS) {
    return translate(
      'browserExtensions.permission.someSites',
      'Read and change your data on {{hosts}}',
      {
        hosts: hosts.join(', ')
      }
    )
  }
  const named = hosts.slice(0, MAX_NAMED_HOSTS).join(', ')
  const count = hosts.length - MAX_NAMED_HOSTS
  return count === 1
    ? translate(
        'browserExtensions.permission.manyOtherSites_one',
        'Read and change your data on {{hosts}} and {{count}} other site',
        { hosts: named, count }
      )
    : translate(
        'browserExtensions.permission.manyOtherSites_other',
        'Read and change your data on {{hosts}} and {{count}} other sites',
        { hosts: named, count }
      )
}

/** Why skip unsupported ones: "It can" must not promise what Orca does not do; they get their own line. */
export function describeBrowserExtensionAccess(
  permissions: string[],
  hostPermissions: string[]
): string[] {
  const messages = [
    hostMessage(hostPermissions),
    ...permissions
      .filter((permission) => unsupportedBrowserExtensionFeatures([permission]).length === 0)
      .map(browserExtensionPermissionWarning)
      .map((warning) => (warning ? permissionMessage(warning) : null))
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
export function describeUnsupportedBrowserExtensionFeatures(permissions: string[]): string | null {
  const features = unsupportedBrowserExtensionFeatures(permissions)
  if (features.length === 0) {
    return null
  }
  return translate(
    'browserExtensions.unsupported.line',
    'Not available in Orca yet: {{features}}.',
    { features: features.map(featureLabel).join(', ') }
  )
}
