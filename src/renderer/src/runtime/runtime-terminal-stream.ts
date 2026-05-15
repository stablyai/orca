import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import type { GlobalSettings } from '../../../shared/types'
import { RuntimeRpcCallError, getActiveRuntimeTarget } from './runtime-rpc-client'
import { getRemoteRuntimeTerminalMultiplexer } from './remote-runtime-terminal-multiplexer'

const REMOTE_PTY_ID_PREFIX = 'remote:'
const REMOTE_PTY_OWNER_SEPARATOR = '@@'

export type RemoteRuntimePtyIdParts = {
  environmentId: string | null
  handle: string
}

export type RuntimeTerminalSubscribeEvent =
  | {
      type: 'scrollback' | 'subscribed'
      streamId?: number | null
      lines?: string[]
      truncated?: boolean
      serialized?: string
      cols?: number
      rows?: number
    }
  | { type: 'data'; chunk: string }
  | { type: 'end' }
  | { type: string; [key: string]: unknown }

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

export function isRuntimeTerminalScrollbackEvent(
  event: RuntimeTerminalSubscribeEvent
): event is Extract<RuntimeTerminalSubscribeEvent, { type: 'scrollback' | 'subscribed' }> {
  return event.type === 'scrollback' || event.type === 'subscribed'
}

export function isRuntimeTerminalDataEvent(
  event: RuntimeTerminalSubscribeEvent
): event is Extract<RuntimeTerminalSubscribeEvent, { type: 'data' }> {
  return event.type === 'data' && typeof (event as { chunk?: unknown }).chunk === 'string'
}

export function runtimeTerminalErrorMessage(error: unknown): string {
  if (error instanceof RuntimeRpcCallError) {
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export function readRuntimeTerminalScrollback(event: {
  serialized?: string
  lines?: string[]
}): string | null {
  if (event.serialized) {
    return event.serialized
  }
  if (event.lines && event.lines.length > 0) {
    return `${event.lines.join('\r\n')}\r\n`
  }
  return null
}

function concatBytes(chunks: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBufferLike> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function createRuntimeTerminalBinaryReader(callbacks: {
  onData: (data: string) => void
  onSnapshot: (data: string) => void
  onEnd?: () => void
}): (bytes: Uint8Array<ArrayBufferLike>) => void {
  let snapshotChunks: Uint8Array<ArrayBufferLike>[] = []

  return (bytes) => {
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Output) {
      callbacks.onData(decodeTerminalStreamText(frame.payload))
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
      snapshotChunks = []
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
      snapshotChunks.push(frame.payload)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
      callbacks.onSnapshot(decodeTerminalStreamText(concatBytes(snapshotChunks)))
      snapshotChunks = []
      callbacks.onEnd?.()
    }
  }
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
