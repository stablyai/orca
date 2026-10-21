import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime-pty-id'

type CopyTerminalHandleDeps = {
  tabId: string
  leafId: string
  /** The pane's bound PTY; a paired-server PTY id already names the owner's handle. */
  ptyId?: string | null
  callRuntime: (request: {
    method: 'terminal.resolvePane'
    params: { paneKey: string }
  }) => Promise<RuntimeRpcResponse<unknown>>
  writeClipboardText: (text: string) => Promise<void>
}

export async function copyTerminalHandleForPane({
  tabId,
  leafId,
  ptyId,
  callRuntime,
  writeClipboardText
}: CopyTerminalHandleDeps): Promise<string> {
  // Why: this desktop's runtime does not own a paired server's pane; the owner's handle is what
  // its CLI addresses, and the PTY binding already carries it.
  if (ptyId && isRemoteRuntimePtyId(ptyId)) {
    const ownerHandle = parseRemoteRuntimePtyId(ptyId)?.handle
    if (!ownerHandle) {
      throw new Error('Terminal ID unavailable')
    }
    await writeClipboardText(ownerHandle)
    return ownerHandle
  }
  const paneKey = makePaneKey(tabId, leafId)
  const response = await callRuntime({
    method: 'terminal.resolvePane',
    params: { paneKey }
  })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const handle = readResolvedTerminalHandle(response.result)
  if (!handle) {
    throw new Error('Terminal ID unavailable')
  }
  await writeClipboardText(handle)
  return handle
}

function readResolvedTerminalHandle(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.terminal)) {
    return null
  }
  return typeof result.terminal.handle === 'string' ? result.terminal.handle : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
