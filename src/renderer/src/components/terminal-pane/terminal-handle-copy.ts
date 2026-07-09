import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'

type CallRuntime = (request: {
  method: 'terminal.resolvePane'
  params: { paneKey: string }
}) => Promise<RuntimeRpcResponse<unknown>>

type CopyTerminalHandleDeps = {
  tabId: string
  leafId: string
  callRuntime: CallRuntime
  writeClipboardText: (text: string) => Promise<void>
}

type CopyTerminalHandleForPaneKeyDeps = {
  paneKey: string
  callRuntime: CallRuntime
  writeClipboardText: (text: string) => Promise<void>
}

export async function copyTerminalHandleForPane({
  tabId,
  leafId,
  callRuntime,
  writeClipboardText
}: CopyTerminalHandleDeps): Promise<string> {
  const paneKey = makePaneKey(tabId, leafId)
  return copyTerminalHandleForPaneKey({
    paneKey,
    callRuntime,
    writeClipboardText
  })
}

// Why: sidebar agent rows only know paneKey; resolve the durable tab/leaf pair
// so orchestration/CLI handles can be copied without opening the terminal pane.
export async function copyTerminalHandleForPaneKey({
  paneKey,
  callRuntime,
  writeClipboardText
}: CopyTerminalHandleForPaneKeyDeps): Promise<string> {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    throw new Error('Terminal ID unavailable')
  }
  const response = await callRuntime({
    method: 'terminal.resolvePane',
    params: { paneKey: makePaneKey(parsed.tabId, parsed.leafId) }
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
