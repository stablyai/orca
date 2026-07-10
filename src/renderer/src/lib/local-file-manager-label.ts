export function getLocalFileManagerLabel(userAgent?: string): string {
  const resolvedUserAgent =
    userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  if (resolvedUserAgent.includes('Mac')) {
    return 'Finder'
  }
  if (resolvedUserAgent.includes('Windows')) {
    return 'File Explorer'
  }
  return 'File Manager'
}
