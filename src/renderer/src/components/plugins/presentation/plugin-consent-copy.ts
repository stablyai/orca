import { translate } from '@/i18n/i18n'
import type { PluginTrust } from './plugin-access-profile'

/** Plain words for the chip: the broadest thing it may do. */
export function pluginTrustLabel(trust: PluginTrust): string {
  if (trust.worker) {
    return translate('auto.components.settings.pluginConsentCopy.fullAccess', 'Full access')
  }
  if (trust.declarative) {
    return trust.recipesOnly
      ? translate('auto.components.settings.pluginConsentCopy.addsVmRecipes', 'Adds VM recipes')
      : translate('auto.components.settings.pluginConsentCopy.addsCommands', 'Adds commands')
  }
  if (trust.panel) {
    return trust.editor
      ? translate(
          'auto.components.settings.pluginConsentCopy.opensAndEditsFiles',
          'Opens and edits files'
        )
      : trust.sidebarPanel
        ? translate('auto.components.settings.pluginConsentCopy.addsPanel', 'Adds a panel')
        : translate('auto.components.settings.pluginConsentCopy.runsPluginCode', 'Runs plugin code')
  }
  return translate('auto.components.settings.pluginConsentCopy.contentOnly', 'Content only')
}

/** Every warning that applies. Panels and editors are the publisher's code, not a sandbox. */
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
  if (trust.panel && !trust.worker) {
    warnings.push(
      translate(
        'auto.components.settings.PluginConsentDialog.uiWarning',
        "Runs the publisher's code inside Orca to draw its view. Orca shows what it can access and asks before enabling it."
      )
    )
  }
  if (warnings.length === 0) {
    warnings.push(
      translate(
        'auto.components.settings.PluginConsentDialog.declarativeWarning',
        'Content only. No code runs.'
      )
    )
  }
  return warnings
}
