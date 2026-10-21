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

/** The file manager's name, for lists of apps a path can be opened in. */
export function getLocalFileManagerLabel(userAgent?: string): string {
  switch (getLocalFileManager(userAgent)) {
    case 'finder':
      return 'Finder'
    case 'file-explorer':
      return 'File Explorer'
    case 'file-manager':
      return 'File Manager'
  }
}
