const PLATFORM_LABELS: Record<NodeJS.Platform, string> = {
  aix: 'AIX',
  android: 'Android',
  cygwin: 'Cygwin',
  darwin: 'macOS',
  freebsd: 'FreeBSD',
  haiku: 'Haiku',
  linux: 'Linux',
  netbsd: 'NetBSD',
  openbsd: 'OpenBSD',
  sunos: 'Solaris',
  win32: 'Windows'
}

export function hostPlatformDisplayName(
  platform: NodeJS.Platform | null | undefined
): string | null {
  return platform ? PLATFORM_LABELS[platform] : null
}
