import { toast } from 'sonner'
import type { BrowserPagePromptHandler } from './browser-page-prompts'
import { BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN } from '../../../../shared/browser/site-settings/browser-site-permission'
import { browserSitePermissionSiteName } from './browser-site-permission-copy'
import { translate } from '@/i18n/i18n'

// Unnamed frames are credited to the tab's site, which `rememberSite` names.
function externalAppDescription(origin: string | null, rememberSite: string | null): string {
  if (origin) {
    return translate(
      'auto.components.browserPane.externalApp.description',
      '{{origin}} wants to open another application.',
      { origin }
    )
  }
  if (rememberSite === BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN) {
    return translate(
      'auto.components.browserPane.externalApp.localFileDescription',
      'A local file wants to open another application.'
    )
  }
  if (rememberSite) {
    return translate(
      'auto.components.browserPane.externalApp.tabSiteDescription',
      'A page on {{site}} wants to open another application.',
      { site: browserSitePermissionSiteName(rememberSite) }
    )
  }
  return translate(
    'auto.components.browserPane.externalApp.anonymousDescription',
    'A page in the browser wants to open another application.'
  )
}

function externalAppAlwaysAllowLabel(rememberSite: string, scheme: string): string {
  return rememberSite === BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN
    ? translate(
        'auto.components.browserPane.externalApp.alwaysAllowLocalFiles',
        'Always allow local files to open {{scheme}} links',
        { scheme }
      )
    : translate(
        'auto.components.browserPane.externalApp.alwaysAllow',
        'Always allow {{site}} to open {{scheme}} links',
        { site: browserSitePermissionSiteName(rememberSite), scheme }
      )
}

export const externalAppPrompt: BrowserPagePromptHandler<'external-app'> = {
  ask: async (confirm, { appName, scheme, origin, rememberSite }, signal) => {
    let always = false
    const open = await confirm({
      signal,
      title: appName
        ? translate('auto.components.browserPane.externalApp.title', 'Open {{app}}?', {
            app: appName
          })
        : translate(
            'auto.components.browserPane.externalApp.schemeTitle',
            'Open this {{scheme}} link?',
            {
              scheme
            }
          ),
      description: externalAppDescription(origin, rememberSite),
      descriptionClassName: '[overflow-wrap:anywhere]',
      confirmLabel: appName
        ? translate('auto.components.browserPane.externalApp.confirm', 'Open {{app}}', {
            app: appName
          })
        : translate('auto.components.browserPane.externalApp.confirmLink', 'Open link'),
      cancelLabel: translate('auto.components.browserPane.externalApp.cancel', 'Cancel'),
      dontAskAgain: rememberSite
        ? {
            label: externalAppAlwaysAllowLabel(rememberSite, scheme),
            onConfirmed: () => {
              always = true
            }
          }
        : undefined
    })
    if (!open) {
      return null
    }
    return always ? 'always' : true
  },
  // Why: the user chose Open, so a silent failure would read as the click doing nothing.
  onFailed: ({ scheme }) => {
    toast.error(
      translate(
        'auto.components.browserPane.externalApp.launchFailed',
        "Couldn't open an app for this {{scheme}} link. It may not be installed.",
        { scheme }
      )
    )
  }
}
