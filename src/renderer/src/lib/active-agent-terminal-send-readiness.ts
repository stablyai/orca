import type { RuntimeTerminalAgentStatus } from '../../../shared/runtime-types'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import type { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

export const ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS = 15000

export type TerminalAgentSendReadiness =
  | 'sendable'
  | 'no-active-terminal'
  | 'no-agent'
  | 'permission'
  | 'status-unavailable'

export type TerminalAgentSendReadinessResult = {
  status: TerminalAgentSendReadiness
  supportsGuardedSend: boolean
}

export async function getTerminalAgentSendReadiness(
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>,
  terminalHandle: string,
  options: { allowLegacyFallback: boolean }
): Promise<TerminalAgentSendReadinessResult> {
  try {
    const { agentStatus } = await callRuntimeRpc<{ agentStatus: RuntimeTerminalAgentStatus }>(
      runtimeTarget,
      'terminal.agentStatus',
      { terminal: terminalHandle },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    if (!agentStatus.isRunningAgent) {
      return { status: 'no-agent', supportsGuardedSend: true }
    }
    if (agentStatus.status === 'permission') {
      return { status: 'permission', supportsGuardedSend: true }
    }
    return { status: 'sendable', supportsGuardedSend: true }
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      if (!options.allowLegacyFallback) {
        // Why: selected-target sends are immediate; without terminal.agentStatus
        // an older remote runtime cannot rule out permission/action prompts.
        return { status: 'status-unavailable', supportsGuardedSend: false }
      }
      // Why: active-focused sends still wait for tui-idle, preserving old
      // runtime compatibility without immediate selected-target risk.
      return {
        status: await getLegacyTerminalAgentSendStatus(runtimeTarget, terminalHandle),
        supportsGuardedSend: false
      }
    }
    if (isRuntimeTerminalUnavailable(error)) {
      return { status: 'no-active-terminal', supportsGuardedSend: false }
    }
    throw error
  }
}

async function getLegacyTerminalAgentSendStatus(
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>,
  terminalHandle: string
): Promise<TerminalAgentSendReadiness> {
  try {
    const { isRunningAgent } = await callRuntimeRpc<{ isRunningAgent: boolean }>(
      runtimeTarget,
      'terminal.isRunningAgent',
      { terminal: terminalHandle },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    return isRunningAgent ? 'sendable' : 'no-agent'
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return 'no-active-terminal'
    }
    throw error
  }
}

export function isRuntimeTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('timeout')
}

export function isRuntimeTerminalUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('terminal_handle_stale') ||
    message.includes('terminal_exited') ||
    message.includes('terminal_gone') ||
    message.includes('no_active_terminal')
  )
}

export function isRuntimeTerminalNotWritable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('terminal_not_writable')
}
