import { translate } from '@/i18n/i18n'
import type { PluginTrust } from './plugin-access-profile'

/** Plain words for the chip: the broadest thing it may do. */
export function pluginTrustLabel(trust: PluginTrust): string {
  if (trust.worker) {
    return translate('auto.components.settings.pluginConsentCopy.fullAccess', 'Full access')
  }
  if (trust.declarative) {
    return translate('auto.components.settings.pluginConsentCopy.addsCommands', 'Adds commands')
  }
  if (trust.panel) {
    return translate('auto.components.settings.pluginConsentCopy.addsPanel', 'Adds a panel')
  }
  return translate('auto.components.settings.pluginConsentCopy.contentOnly', 'Content only')
}

/** Every warning that applies. A sandboxed panel has none: its capabilities say what it can do. */
export function pluginTrustWarnings(trust: PluginTrust): string[] {
  const warnings: string[] = []
  if (trust.worker) {
    warnings.push(
      translate(
        'auto.components.settings.PluginConsentDialog.fullAccessWarning',
        'Full access: runs as a normal program and can read your files, use the network and run other programs.'
      )
    )
  }
  if (trust.declarative) {
    warnings.push(
      translate(
        'auto.components.settings.PluginConsentDialog.instructionalWarning',
        'Its commands can act for you or your agents'
      )
    )
  }
  if (warnings.length === 0 && !trust.panel) {
    warnings.push(
      translate(
        'auto.components.settings.PluginConsentDialog.declarativeWarning',
        'Content only. No code runs.'
      )
    )
  }
  return warnings
}
