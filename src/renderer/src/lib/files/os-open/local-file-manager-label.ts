import { translate } from '@/i18n/i18n'

type LocalFileManager = 'finder' | 'file-explorer' | 'file-manager'

export function getLocalFileManager(userAgent?: string): LocalFileManager {
  const resolvedUserAgent =
    userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  if (resolvedUserAgent.includes('Mac')) {
    return 'finder'
  }
  if (resolvedUserAgent.includes('Windows')) {
    return 'file-explorer'
  }
  return 'file-manager'
}

export function getLocalFileManagerLabel(userAgent?: string): string {
  switch (getLocalFileManager(userAgent)) {
    case 'finder':
      return translate('auto.lib.local.file.manager.label.eb052ab0f6', 'Finder')
    case 'file-explorer':
      return translate('auto.lib.local.file.manager.label.f2aa906c95', 'File Explorer')
    case 'file-manager':
      return translate('auto.lib.local.file.manager.label.8247848395', 'File Manager')
  }
}

export function getOpenInLocalFileManagerLabel(userAgent?: string): string {
  return translate('auto.lib.local.file.manager.label.85cc2c844c', 'Open in {{name}}', {
    name: getLocalFileManagerLabel(userAgent)
  })
}

export function getOpenInLocalFileManagerPrefix(): string {
  return translate('auto.lib.local.file.manager.label.57b632c0bd', 'Open in ')
}
