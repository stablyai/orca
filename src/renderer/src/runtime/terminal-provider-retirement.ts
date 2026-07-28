import {
  TERMINAL_TAB_PROVIDER_RPC_TIMEOUT_MS,
  TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS
} from '../../../shared/terminal-tab-close'
import { callRuntimeRpc, RuntimeRpcCallError, type RuntimeClientTarget } from './runtime-rpc-client'

function remainingTimeoutMs(deadlineMs: number, errorCode: string): number {
  const remainingMs = deadlineMs - Date.now()
  if (remainingMs <= 0) {
    throw new Error(errorCode)
  }
  return remainingMs
}

export async function retireRuntimeTerminalProvider(
  target: RuntimeClientTarget,
  terminal: string,
  options: {
    providerTimeoutMs?: number
    rpcTimeoutMs?: number
  } = {}
): Promise<void> {
  const providerDeadlineMs =
    Date.now() + (options.providerTimeoutMs ?? TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS)
  const rpcTimeoutMs = options.rpcTimeoutMs ?? TERMINAL_TAB_PROVIDER_RPC_TIMEOUT_MS
  const rpcDeadlineMs = Date.now() + rpcTimeoutMs
  // Why: subscription transport bounds queueing, connection, and response under the shared RPC wall.
  const rpcSignal = target.kind === 'environment' ? AbortSignal.timeout(rpcTimeoutMs) : undefined
  const rpcOptions = (): {
    timeoutMs: number
    signal?: AbortSignal
    skipCompatibilityCheck: true
  } => ({
    timeoutMs: remainingTimeoutMs(rpcDeadlineMs, 'terminal_provider_teardown_timeout'),
    ...(rpcSignal ? { signal: rpcSignal } : {}),
    skipCompatibilityCheck: true
  })

  try {
    await callRuntimeRpc(
      target,
      'terminal.closeProvider',
      {
        terminal,
        timeoutMs: remainingTimeoutMs(providerDeadlineMs, 'terminal_provider_teardown_timeout')
      },
      rpcOptions()
    )
  } catch (error) {
    if (!(error instanceof RuntimeRpcCallError) || error.code !== 'method_not_found') {
      throw error
    }
    // Why: legacy terminal.wait treats provider disconnect as exit and cannot prove physical teardown.
    throw new Error('terminal_provider_teardown_requires_runtime_upgrade')
  }
}
