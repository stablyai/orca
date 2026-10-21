import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
export function getTerminalIncarnationHandle(ptyId: string, environmentId: string): string | null {
  const terminal = parseRemoteRuntimePtyId(ptyId)
  if (terminal?.handle && terminal.environmentId === environmentId) {
    return terminal.handle
  }
  return null
}
