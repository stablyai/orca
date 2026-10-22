import { BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN } from '../../../../shared/browser-site-permission'
import type { BrowserPagePromptHandler } from './browser-page-prompts'
import {
  browserSitePermissionRequestLine,
  browserSitePermissionSiteName
} from './browser-site-permission-copy'
import { translate } from '@/i18n/i18n'

export const sitePermissionPrompt: BrowserPagePromptHandler<'site-permission'> = {
  ask: async (confirm, { origin, permissions }, signal) => {
    let blocked = false
    const allowed = await confirm({
      signal,
      title:
        origin === BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN
          ? translate('auto.components.browserPane.sitePermission.fileTitle', 'This file wants to')
          : translate('auto.components.browserPane.sitePermission.title', '{{site}} wants to', {
              site: browserSitePermissionSiteName(origin)
            }),
      description: permissions.map(browserSitePermissionRequestLine).join('\n'),
      confirmLabel: translate('auto.components.browserPane.sitePermission.allow', 'Allow'),
      cancelLabel: translate('auto.components.browserPane.sitePermission.block', 'Block'),
      // Why: the click or Enter that made the page ask must not answer for the user.
      ignoresOpeningGesture: true,
      onCancelClicked: () => {
        blocked = true
      }
    })
    if (allowed) {
      return 'allow'
    }
    // Why: Block is remembered for the site; Esc only declines this time, as in Chrome.
    return blocked ? 'block' : null
  }
}
