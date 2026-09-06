import type { RuntimeTerminalAgentStatus } from '../../../shared/runtime-types'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import type { ActiveAgentNotesSendFailureCode } from './active-agent-note-send-result'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import type { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
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
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>,
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
