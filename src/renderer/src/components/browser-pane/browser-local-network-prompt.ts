import type { BrowserPagePromptHandler } from './browser-page-prompts'
import { translate } from '@/i18n/i18n'

export const localNetworkPrompt: BrowserPagePromptHandler<'local-network'> = {
  ask: async (confirm, { origin }, signal) => {
    const allowed = await confirm({
      signal,
      title: translate(
        'auto.components.browserPane.localNetwork.title',
        'Apps and services on this device / local network'
      ),
      description: translate(
        'auto.components.browserPane.localNetwork.description',
        '{{origin}} wants to connect to apps and services on this device or your local network. Allow this only for sites you trust.',
        { origin }
      ),
      descriptionClassName: 'break-all',
      confirmLabel: translate('auto.components.browserPane.localNetwork.confirm', 'Allow'),
      cancelLabel: translate('auto.components.browserPane.localNetwork.cancel', 'Deny')
    })
    return allowed ? true : null
  }
}
