import {
  BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN,
  type BrowserSitePermission
} from '../../../../shared/browser-site-permission'
import { translate } from '@/i18n/i18n'

/** The setting's name, e.g. in Settings → Browser → Site permissions. */
export function browserSitePermissionLabel(permission: BrowserSitePermission): string {
  switch (permission) {
    case 'camera':
      return translate('auto.components.browserPane.sitePermission.label.camera', 'Camera')
    case 'microphone':
      return translate('auto.components.browserPane.sitePermission.label.microphone', 'Microphone')
    case 'location':
      return translate('auto.components.browserPane.sitePermission.label.location', 'Location')
    case 'notifications':
      return translate(
        'auto.components.browserPane.sitePermission.label.notifications',
        'Notifications'
      )
    case 'clipboard':
      return translate('auto.components.browserPane.sitePermission.label.clipboard', 'Clipboard')
    case 'midi':
      return translate('auto.components.browserPane.sitePermission.label.midi', 'MIDI devices')
    case 'window-management':
      return translate(
        'auto.components.browserPane.sitePermission.label.windowManagement',
        'Window management'
      )
    case 'idle-detection':
      return translate(
        'auto.components.browserPane.sitePermission.label.idleDetection',
        'Device use'
      )
    case 'local-network':
      return translate(
        'auto.components.browserPane.sitePermission.label.localNetwork',
        'Local network'
      )
  }
}

/** What the site asks to do, finishing "{site} wants to". */
export function browserSitePermissionRequestLine(permission: BrowserSitePermission): string {
  switch (permission) {
    case 'camera':
      return translate('auto.components.browserPane.sitePermission.ask.camera', 'Use your camera')
    case 'microphone':
      return translate(
        'auto.components.browserPane.sitePermission.ask.microphone',
        'Use your microphone'
      )
    case 'location':
      return translate(
        'auto.components.browserPane.sitePermission.ask.location',
        'Know your location'
      )
    case 'notifications':
      return translate(
        'auto.components.browserPane.sitePermission.ask.notifications',
        'Show notifications'
      )
    case 'clipboard':
      return translate(
        'auto.components.browserPane.sitePermission.ask.clipboard',
        'See text and images copied to the clipboard'
      )
    case 'midi':
      return translate(
        'auto.components.browserPane.sitePermission.ask.midi',
        'Use your MIDI devices'
      )
    case 'window-management':
      return translate(
        'auto.components.browserPane.sitePermission.ask.windowManagement',
        'Manage windows on all your displays'
      )
    case 'idle-detection':
      return translate(
        'auto.components.browserPane.sitePermission.ask.idleDetection',
        'Know when you are actively using this device'
      )
    case 'local-network':
      return translate(
        'auto.components.browserPane.sitePermission.ask.localNetwork',
        'Access apps on this device and devices on your local network'
      )
  }
}

/** The origin as people read it: the host for https, the full origin otherwise. */
export function browserSitePermissionSiteName(origin: string): string {
  if (origin === BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN) {
    return translate('auto.components.browserPane.sitePermission.localFiles', 'Local files')
  }
  return origin.startsWith('https://') ? origin.slice('https://'.length) : origin
}
