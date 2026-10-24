import { translate } from '@/i18n/i18n'
import type { PluginTrust } from './plugin-access-profile'

/** Plain words for the chip: the broadest thing it may do. */
export function pluginTrustLabel(trust: PluginTrust): string {
  if (trust.worker) {
    return translate('auto.components.settings.pluginConsentCopy.runsWorker', 'Runs a worker')
  }
  if (trust.instructional) {
    return translate('auto.components.settings.pluginConsentCopy.addsCommands', 'Adds commands')
  }
  if (trust.panel) {
    return translate('auto.components.settings.pluginConsentCopy.addsPanel', 'Adds a panel')
  }
  return translate('auto.components.settings.pluginConsentCopy.contentOnly', 'Content only')
}

/** Every warning that applies; the panel's "bounded" line only when nothing broader does. */
export function pluginTrustWarnings(trust: PluginTrust): string[] {
  const warnings: string[] = []
  if (trust.worker) {
    warnings.push(
      translate(
        'auto.components.settings.PluginConsentDialog.warning',
        'Its worker runs as a normal process with full access to your files, network, and other processes.'
      )
    )
  }
  if (trust.instructional) {
    warnings.push(
      translate(
        'auto.components.settings.PluginConsentDialog.instructionalWarning',
        'Its commands and instructions can take actions when you or an agent use them.'
      )
    )
  }
  if (trust.panel && warnings.length === 0) {
    warnings.push(
      translate(
        'auto.components.settings.PluginConsentDialog.panelWarning',
        'No background worker. These permissions limit what it can do in Orca.'
      )
    )
  }
  if (warnings.length === 0) {
    warnings.push(
      translate(
        'auto.components.settings.PluginConsentDialog.declarativeWarning',
        "Content only: no code, no background worker, and no access to Orca's API."
      )
    )
  }
  return warnings
}
