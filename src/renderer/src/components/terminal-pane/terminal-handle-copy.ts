import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { makePaneKey } from '../../../../shared/stable-pane-id'

type CopyTerminalHandleDeps = {
  tabId: string
  leafId: string
  callRuntime: (request: {
    method: 'terminal.resolvePane'
    params: { paneKey: string }
  }) => Promise<RuntimeRpcResponse<unknown>>
  writeClipboardText: (text: string) => Promise<void>
}

type ResolveDeps = Pick<CopyTerminalHandleDeps, 'tabId' | 'leafId' | 'callRuntime'>

// Why: single network round trip shared by both callers below, so paneKey
// construction and the RPC shape live in one place.
function fetchTerminalResolution({
  tabId,
  leafId,
  callRuntime
}: ResolveDeps): Promise<RuntimeRpcResponse<unknown>> {
  const paneKey = makePaneKey(tabId, leafId)
  return callRuntime({
    method: 'terminal.resolvePane',
    params: { paneKey }
  })
}

export async function copyTerminalHandleForPane({
  tabId,
  leafId,
  callRuntime,
  writeClipboardText
}: CopyTerminalHandleDeps): Promise<string> {
  const response = await fetchTerminalResolution({ tabId, leafId, callRuntime })
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

// Why: shared by the peer-collab viewer badge, which needs a pane's terminal
// handle to match against DeviceEntry.grantedTerminalHandles / subscribedTerminals
// without surfacing a copy-to-clipboard side effect.
export async function resolveTerminalHandleForPane({
  tabId,
  leafId,
  callRuntime
}: ResolveDeps): Promise<string | null> {
  const response = await fetchTerminalResolution({ tabId, leafId, callRuntime })
  return response.ok ? readResolvedTerminalHandle(response.result) : null
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
