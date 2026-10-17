export const WINDOWS_NIUBASH_SHELL = 'niu.exe'

export function isNiubashShell(shell: string): boolean {
  const name = shell.trim().replaceAll('\\', '/').split('/').pop()?.toLowerCase()
  return name === 'niu' || name === WINDOWS_NIUBASH_SHELL
}
