import '../streams/registry/remote-runtime-terminal-multiplexer-registry'
import { parseRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'

export function getRemoteRuntimeTerminalHandle(ptyId: string): string | null {
  return parseRemoteRuntimePtyId(ptyId)?.handle ?? null
}

export function getRemoteRuntimePtyEnvironmentId(ptyId: string): string | null {
  return parseRemoteRuntimePtyId(ptyId)?.environmentId ?? null
}

/**
 * The server a remote PTY belongs to, named by the id itself. An id without an owner segment names
 * no server, so it is never dialed on whichever server happens to be focused.
 */
export function getRemoteRuntimePtyOwner(
  ptyId: string
): { target: { kind: 'environment'; environmentId: string }; terminal: string } | null {
  const parsed = parseRemoteRuntimePtyId(ptyId)
  return parsed?.environmentId && parsed.handle
    ? {
        target: { kind: 'environment', environmentId: parsed.environmentId },
        terminal: parsed.handle
      }
    : null
}
