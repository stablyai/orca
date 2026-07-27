import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { makePaneKey } from '../../../../shared/stable-pane-id'

type CopyTerminalHandleDeps = {
  tabId: string
  leafId: string
  // Why: a pane rendered from a paired runtime exists only in that runtime's
  // pane table, so resolvePane has to be addressed to the owner. Defaulting to
  // the local runtime made "Copy Terminal ID" fail for every remote pane.
  runtimeEnvironmentId?: string | null
  callRuntime: (
    target: RuntimeClientTarget,
    method: 'terminal.resolvePane',
    params: { paneKey: string }
  ) => Promise<unknown>
  writeClipboardText: (text: string) => Promise<void>
}

export async function copyTerminalHandleForPane({
  tabId,
  leafId,
  runtimeEnvironmentId,
  callRuntime,
  writeClipboardText
}: CopyTerminalHandleDeps): Promise<string> {
  const paneKey = makePaneKey(tabId, leafId)
  const environmentId = runtimeEnvironmentId?.trim()
  const target: RuntimeClientTarget = environmentId
    ? { kind: 'environment', environmentId }
    : { kind: 'local' }
  const result = await callRuntime(target, 'terminal.resolvePane', { paneKey })
  const handle = readResolvedTerminalHandle(result)
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
