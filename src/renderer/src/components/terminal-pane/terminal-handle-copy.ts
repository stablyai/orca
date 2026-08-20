import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { makePaneKey } from '../../../../shared/stable-pane-id'

type CopyTerminalHandleDeps = {
  tabId: string
  leafId: string
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
  // Why: relay panes live on the remote runtime. Local resolvePane cannot see them.
  const remoteHandle = ptyId ? parseRemoteRuntimePtyId(ptyId)?.handle.trim() : ''
  if (remoteHandle) {
    await writeClipboardText(remoteHandle)
    return remoteHandle
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
