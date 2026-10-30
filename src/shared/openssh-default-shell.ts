import { runProcessSync } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'

const OPENSSH_REGISTRY_KEY = 'HKLM\\SOFTWARE\\OpenSSH'
let openSshDefaultShell: string | undefined

/** The Windows OpenSSH server's `DefaultShell` login shell, or '' when unset or unreadable. Memoized. */
export function readOpenSshDefaultShell(): string {
  if (openSshDefaultShell !== undefined) {
    return openSshDefaultShell
  }

  try {
    const result = runProcessSync({
      program: windowsSystem32Binary('reg.exe'),
      args: ['query', OPENSSH_REGISTRY_KEY, '/v', 'DefaultShell'],
      timeoutMs: 3000
    })
    const match =
      result.code === 0 ? result.stdout.match(/^\s*DefaultShell\s+REG_\w+\s+(.+?)\s*$/im) : null
    openSshDefaultShell = match?.[1] ?? ''
  } catch {
    openSshDefaultShell = ''
  }

  return openSshDefaultShell
}
