import type { RuntimeTerminalAgentStatus } from '../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type {
  RuntimeTerminalClientPaste,
  RuntimeTerminalClientPasteReceipt
} from '../../../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import { hasRuntimeRpcErrorCode } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import type { ActiveAgentNotesSendFailureCode } from './active-agent-note-send-result'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
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
  /** The host's receipt for the paste asked about. Older hosts omit it. */
  clientPaste?: RuntimeTerminalClientPasteReceipt
}

export async function getTerminalAgentSendReadiness(
  runtimeTarget: RuntimeClientTarget,
  terminalHandle: string,
  options: { allowLegacyFallback: boolean },
  clientPaste?: RuntimeTerminalClientPaste
): Promise<TerminalAgentSendReadinessResult> {
  try {
    const {
      agentStatus,
      inputGeneration,
      resolvedInputGeneration,
      clientPaste: receipt
    } = await callRuntimeRpc<{
      agentStatus: RuntimeTerminalAgentStatus
      inputGeneration?: number
      resolvedInputGeneration?: number
      clientPaste?: RuntimeTerminalClientPasteReceipt
    }>(
      runtimeTarget,
      'terminal.agentStatus',
      { terminal: terminalHandle, ...(clientPaste ? { clientPaste } : {}) },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    const input = {
      ...(Number.isSafeInteger(inputGeneration) ? { inputGeneration } : {}),
      ...(Number.isSafeInteger(resolvedInputGeneration) ? { resolvedInputGeneration } : {}),
      ...(clientPaste && isClientPasteReceipt(receipt) ? { clientPaste: receipt } : {})
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

function isClientPasteReceipt(value: unknown): value is RuntimeTerminalClientPasteReceipt {
  if (typeof value !== 'object' || value === null || !('state' in value)) {
    return false
  }
  const settles = 'settlesInMs' in value && isDelayMs(value.settlesInMs)
  switch (value.state) {
    case 'withdrawn':
    case 'refused':
    case 'unknown':
      return true
    case 'writing':
      return settles
    case 'written':
      return settles && 'inputGeneration' in value && Number.isSafeInteger(value.inputGeneration)
    default:
      return false
  }
}

function isDelayMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
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
