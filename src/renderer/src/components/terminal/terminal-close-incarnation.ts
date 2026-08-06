import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
export function getTerminalIncarnationHandle(ptyId: string, environmentId: string): string | null {
  const terminal = parseRemoteRuntimePtyId(ptyId)
  if (terminal?.handle && terminal.environmentId === environmentId) {
    return terminal.handle
  }
  return null
}
