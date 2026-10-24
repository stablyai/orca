import { translate } from '@/i18n/i18n'

function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).toLowerCase()
}

export function pluginInstallErrorMessage(cause: unknown): string {
  const detail = errorText(cause)
  if (detail.includes('orca-plugin.json') && /(missing|unreadable|no )/.test(detail)) {
    return translate(
      'auto.components.settings.pluginError.installManifestMissing',
      "No readable orca-plugin.json was found. Choose the plugin's root folder."
    )
  }
  if (detail.includes('invalid manifest')) {
    return translate(
      'auto.components.settings.pluginError.installManifestInvalid',
      'orca-plugin.json is invalid. Ask the plugin author to fix the manifest.'
    )
  }
  if (detail.includes('requires orca')) {
    return translate(
      'auto.components.settings.pluginError.incompatible',
      'This plugin requires a different Orca version.'
    )
  }
  if (/(symlink|outside|absolute|path traversal|drive prefix)/.test(detail)) {
    return translate(
      'auto.components.settings.pluginError.installUnsafePath',
      'The plugin contains an unsafe file path or symlink and was not installed.'
    )
  }
  if (/(exceeds|too many)/.test(detail)) {
    return translate(
      'auto.components.settings.pluginError.installLimit',
      "The plugin exceeds Orca's install size or file-count limits."
    )
  }
  if (/(git|repository|fetch|clone|checkout|remote)/.test(detail)) {
    return translate(
      'auto.components.settings.pluginError.installGit',
      "Couldn't fetch this Git revision. Check the URL, #ref, and access."
    )
  }
  return translate(
    'auto.components.settings.PluginInstallDialog.installFailed',
    'Plugin installation failed. Check the source and try again.'
  )
}

export function invalidPluginErrorMessage(detailValue: string): string {
  const detail = detailValue.toLowerCase()
  if (detail.includes('missing orca-plugin.json')) {
    return translate(
      'auto.components.settings.pluginError.invalidManifestMissing',
      'The plugin root is missing orca-plugin.json. Add it, then refresh plugins.'
    )
  }
  if (detail.includes('invalid manifest')) {
    return translate(
      'auto.components.settings.pluginError.invalidManifest',
      'orca-plugin.json is invalid. Fix it, then refresh plugins.'
    )
  }
  if (detail.includes('artifact')) {
    return translate(
      'auto.components.settings.pluginError.invalidArtifact',
      'A worker or panel file is missing or unsafe. Fix it, then refresh.'
    )
  }
  if (detail.includes('requires orca')) {
    return translate(
      'auto.components.settings.pluginError.incompatible',
      'This plugin requires a different Orca version.'
    )
  }
  return translate(
    'auto.components.settings.PluginSettingsRow.invalidPluginError',
    "This plugin's files are invalid. Fix them, then refresh."
  )
}

export function pluginConsentErrorMessage(cause: unknown): string {
  const detail = errorText(cause)
  if (/(changed|fingerprint|current|stale|review)/.test(detail)) {
    return translate(
      'auto.components.settings.pluginError.consentChanged',
      'This plugin changed while you were reviewing it. Review it again.'
    )
  }
  return translate(
    'auto.components.settings.PluginConsentDialog.decisionFailed',
    'Could not save the permission decision. Try again.'
  )
}
