export type PtyOwnerBackend = 'posix-pty' | 'windows-conpty' | 'windows-wsl'

function shellBasename(shellPath: string | undefined): string {
  return shellPath?.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
}

export function resolvePtyOwnerBackend(args: {
  platform: NodeJS.Platform
  shellPath: string | undefined
  wslDistro?: string | null
}): PtyOwnerBackend {
  if (args.platform !== 'win32') {
    return 'posix-pty'
  }
  const shell = shellBasename(args.shellPath)
  if (shell === 'wsl.exe' || shell === 'wsl') {
    return 'windows-wsl'
  }
  // Why: requested WSL metadata can survive a spawn fallback; the winning native shell owns the PTY.
  if (!shell && args.wslDistro) {
    return 'windows-wsl'
  }
  return 'windows-conpty'
}
