import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime/remote-runtime-pty-id'

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

export async function copyTerminalHandleForPane(args: CopyTerminalHandleDeps): Promise<string> {
  const handle = await resolveTerminalHandleForPane(args)
  await args.writeClipboardText(handle)
  return handle
}

export async function resolveTerminalHandleForPane({
  tabId,
  leafId,
  ptyId,
  callRuntime
}: Omit<CopyTerminalHandleDeps, 'writeClipboardText'>): Promise<string> {
  // Use the paired owner’s bound handle; this desktop’s runtime cannot resolve the server’s pane.
  if (ptyId && isRemoteRuntimePtyId(ptyId)) {
    const ownerHandle = parseRemoteRuntimePtyId(ptyId)?.handle
    if (!ownerHandle) {
      throw new Error('Terminal ID unavailable')
    }
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
