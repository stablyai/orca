import type { RuntimeTerminalAgentStatus } from '../../../../../../shared/runtime-terminal-contracts'
import { hasRuntimeRpcErrorCode } from '../../../../../../shared/runtime-rpc-error-code'
import type { ActiveAgentNotesSendFailureCode } from './active-agent-note-send-result'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  runtimeFailureCode,
  TERMINAL_RUNTIME_FAILURE_CODES
} from './active-agent-note-send-diagnostics'

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
  code?: ActiveAgentNotesSendFailureCode
  /** Names the terminal's last input, as a paste receipt does. Older hosts omit it. */
  inputGeneration?: number
  resolvedInputGeneration?: number
}

export async function getTerminalAgentSendReadiness(
  runtimeTarget: RuntimeClientTarget,
  terminalHandle: string,
  options: { allowLegacyFallback: boolean }
): Promise<TerminalAgentSendReadinessResult> {
  try {
    const { agentStatus, inputGeneration, resolvedInputGeneration } = await callRuntimeRpc<{
      agentStatus: RuntimeTerminalAgentStatus
      inputGeneration?: number
      resolvedInputGeneration?: number
    }>(
      runtimeTarget,
      'terminal.agentStatus',
      { terminal: terminalHandle },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    const input = {
      ...(Number.isSafeInteger(inputGeneration) ? { inputGeneration } : {}),
      ...(Number.isSafeInteger(resolvedInputGeneration) ? { resolvedInputGeneration } : {})
    }
    if (!agentStatus.isRunningAgent) {
      return { status: 'no-agent', supportsGuardedSend: true, ...input }
    }
    if (agentStatus.status === 'permission') {
      return { status: 'permission', supportsGuardedSend: true, ...input }
    }
    return { status: 'sendable', supportsGuardedSend: true, ...input }
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      if (!options.allowLegacyFallback) {
        // Immediate selected-target sends require agentStatus to rule out permission/action prompts on older hosts.
        return { status: 'status-unavailable', supportsGuardedSend: false }
      }
      // Focused sends still wait for tui-idle, preserving older-runtime compatibility.
      return await getLegacyTerminalAgentSendStatus(runtimeTarget, terminalHandle)
    }
    if (isRuntimeTerminalUnavailable(error)) {
      return {
        status: 'no-active-terminal',
        supportsGuardedSend: false,
        code: runtimeTerminalUnavailableCode(error)
      }
    }
    throw error
  }
}

async function getLegacyTerminalAgentSendStatus(
  runtimeTarget: RuntimeClientTarget,
  terminalHandle: string
): Promise<TerminalAgentSendReadinessResult> {
  try {
    const { isRunningAgent } = await callRuntimeRpc<{ isRunningAgent: boolean }>(
      runtimeTarget,
      'terminal.isRunningAgent',
      { terminal: terminalHandle },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    return {
      status: isRunningAgent ? 'sendable' : 'no-agent',
      supportsGuardedSend: false
    }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return {
        status: 'no-active-terminal',
        supportsGuardedSend: false,
        code: runtimeTerminalUnavailableCode(error)
      }
    }
    throw error
  }
}

function runtimeTerminalUnavailableCode(error: unknown): ActiveAgentNotesSendFailureCode {
  return runtimeFailureCode(error) ?? 'runtime-unverifiable'
}

export function isRuntimeTimeout(error: unknown): boolean {
  if (hasRuntimeRpcErrorCode(error, 'runtime_timeout')) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('timeout')
}

export function isRuntimeTerminalUnavailable(error: unknown): boolean {
  return TERMINAL_RUNTIME_FAILURE_CODES.some((code) => hasRuntimeRpcErrorCode(error, code))
}

export function isRuntimeTerminalNotWritable(error: unknown): boolean {
  return hasRuntimeRpcErrorCode(error, 'terminal_not_writable')
}
