import { translate } from '@/i18n/i18n'

export function getLocalFileManagerLabel(userAgent?: string): string {
  const resolvedUserAgent =
    userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  if (resolvedUserAgent.includes('Mac')) {
    return translate('auto.lib.local.file.manager.label.eb052ab0f6', 'Finder')
  }
  if (resolvedUserAgent.includes('Windows')) {
    return translate('auto.lib.local.file.manager.label.f2aa906c95', 'File Explorer')
  }
  return translate('auto.lib.local.file.manager.label.8247848395', 'File Manager')
}

export function getOpenInLocalFileManagerLabel(userAgent?: string): string {
  return translate('auto.lib.local.file.manager.label.85cc2c844c', 'Open in {{name}}', {
    name: getLocalFileManagerLabel(userAgent)
  })
}

export function getOpenInLocalFileManagerPrefix(): string {
  return translate('auto.lib.local.file.manager.label.57b632c0bd', 'Open in ')
}
