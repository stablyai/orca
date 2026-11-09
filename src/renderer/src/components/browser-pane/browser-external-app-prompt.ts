import { toast } from 'sonner'
import type { BrowserPagePromptHandler } from './browser-page-prompts'
import { translate } from '@/i18n/i18n'

export const externalAppPrompt: BrowserPagePromptHandler<'external-app'> = {
  ask: async (confirm, { appName, scheme, origin }, signal) => {
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
      description: origin
        ? translate(
            'auto.components.browserPane.externalApp.description',
            '{{origin}} wants to open another application.',
            { origin }
          )
        : translate(
            'auto.components.browserPane.externalApp.anonymousDescription',
            'A page in the browser wants to open another application.'
          ),
      descriptionClassName: 'break-all',
      confirmLabel: appName
        ? translate('auto.components.browserPane.externalApp.confirm', 'Open {{app}}', {
            app: appName
          })
        : translate('auto.components.browserPane.externalApp.confirmLink', 'Open link'),
      cancelLabel: translate('auto.components.browserPane.externalApp.cancel', 'Cancel')
    })
    return open ? true : null
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
