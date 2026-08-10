import { translate } from '@/i18n/i18n'

export function getCliRevealLabel(platform: string): string {
  if (platform === 'darwin') {
    return translate('auto.components.settings.CliSection.showInFinder', 'Show in Finder')
  }
  if (platform === 'win32') {
    return translate('auto.components.settings.CliSection.showInExplorer', 'Show in Explorer')
  }
  return translate('auto.components.settings.CliSection.showInFileManager', 'Show in File Manager')
}

export function getCliInstallDescription(platform: string): string {
  if (platform === 'darwin') {
    return translate(
      'auto.components.settings.CliSection.registerInUsrLocalBin',
      'Register `orca` in /usr/local/bin.'
    )
  }
  if (platform === 'linux') {
    return translate(
      'auto.components.settings.CliSection.registerInLocalBin',
      'Register `orca-ide` in ~/.local/bin.'
    )
  }
  if (platform === 'win32') {
    return translate(
      'auto.components.settings.CliSection.registerInUserPath',
      'Register `orca` in your user PATH.'
    )
  }
  return translate(
    'auto.components.settings.CliSection.registrationUnavailable',
    'CLI registration is not yet available on this platform.'
  )
}
