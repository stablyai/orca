import { translate } from '@/i18n/i18n'

export function getLocalFileManagerLabel(userAgent?: string): string {
  const resolvedUserAgent =
    userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  if (resolvedUserAgent.includes('Mac')) {
    return translate('auto.components.osReveal.fileManagerFinder', 'Finder')
  }
  if (resolvedUserAgent.includes('Windows')) {
    return translate('auto.components.osReveal.fileManagerExplorer', 'File Explorer')
  }
  return translate('auto.components.osReveal.fileManagerGeneric', 'File Manager')
}

export function getOpenInLocalFileManagerLabel(userAgent?: string): string {
  return translate('auto.components.osReveal.openInFileManager', 'Open in {{name}}', {
    name: getLocalFileManagerLabel(userAgent)
  })
}

export function getOpenInLocalFileManagerPrefix(): string {
  return translate('auto.components.osReveal.openInPrefix', 'Open in ')
}
