import type { GlobalSettings } from '../../../shared/types'
import { RuntimeRpcCallError, getActiveRuntimeTarget } from './runtime-rpc-client'
import { getRemoteRuntimeTerminalMultiplexer } from './remote-runtime-terminal-multiplexer'

const REMOTE_PTY_ID_PREFIX = 'remote:'
const REMOTE_PTY_OWNER_SEPARATOR = '@@'

export type RemoteRuntimePtyIdParts = {
  environmentId: string | null
  handle: string
}

export function toRemoteRuntimePtyId(handle: string, environmentId?: string | null): string {
  const owner = environmentId?.trim()
  if (!owner) {
    return `${REMOTE_PTY_ID_PREFIX}${handle}`
  }
  return `${REMOTE_PTY_ID_PREFIX}${encodeURIComponent(owner)}${REMOTE_PTY_OWNER_SEPARATOR}${encodeURIComponent(handle)}`
}

export function parseRemoteRuntimePtyId(ptyId: string): RemoteRuntimePtyIdParts | null {
  if (!ptyId.startsWith(REMOTE_PTY_ID_PREFIX)) {
    return null
  }
  const rest = ptyId.slice(REMOTE_PTY_ID_PREFIX.length)
  const separatorIndex = rest.indexOf(REMOTE_PTY_OWNER_SEPARATOR)
  if (separatorIndex === -1) {
    return { environmentId: null, handle: rest }
  }
  return {
    environmentId: decodeURIComponent(rest.slice(0, separatorIndex)),
    handle: decodeURIComponent(rest.slice(separatorIndex + REMOTE_PTY_OWNER_SEPARATOR.length))
  }
}

export function getRemoteRuntimeTerminalHandle(ptyId: string): string | null {
  return parseRemoteRuntimePtyId(ptyId)?.handle ?? null
}

export function getRemoteRuntimePtyEnvironmentId(ptyId: string): string | null {
  return parseRemoteRuntimePtyId(ptyId)?.environmentId ?? null
}

export function runtimeTerminalErrorMessage(error: unknown): string {
  if (error instanceof RuntimeRpcCallError) {
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export async function subscribeToRuntimeTerminalData(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  clientId: string,
  watcher: (data: string) => void
): Promise<() => void> {
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment' || !terminal) {
    return () => {}
  }

  const stream = await getRemoteRuntimeTerminalMultiplexer(target.environmentId).subscribeTerminal({
    terminal,
    client: { id: clientId, type: 'desktop' },
    callbacks: {
      onData: watcher,
      onSnapshot: watcher
    }
  })

  return () => stream.close()
}
