import { quotePosixShellUnlessPlain } from './shell-argument-quoting'

// Quote for the receiving shell, not client OS; Windows-to-Linux SSH drops need POSIX escaping.
export function shellEscapePath(path: string, targetShell: 'posix' | 'windows'): string {
  if (targetShell === 'windows') {
    return /^[a-zA-Z0-9_./@:\\-]+$/.test(path) ? path : `"${path}"`
  }

  return quotePosixShellUnlessPlain(path)
}
