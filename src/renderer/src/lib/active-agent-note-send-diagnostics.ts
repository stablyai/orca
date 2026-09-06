import type { ActiveTerminalNoteTarget } from './active-agent-note-target'
import type {
  ActiveAgentNotesSendFailureCode,
  ActiveAgentNotesSendResult
} from './active-agent-note-send-result'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'

export const TERMINAL_RUNTIME_FAILURE_CODES = [
  'terminal_handle_stale',
  'terminal_exited',
  'terminal_gone',
  'no_active_terminal'
] as const

export function reportNoteSendFailure(
  result: ActiveAgentNotesSendResult,
  noteTarget: ActiveTerminalNoteTarget | null
): ActiveAgentNotesSendResult {
  if (result.status === 'sent' || result.status === 'empty') {
    return result
  }
  const code = result.code ?? codeForStatus(result.status)
  console.warn('[review-notes] send failed', {
    code,
    status: result.status,
    tabId: noteTarget?.tabId,
    leafId: noteTarget?.leafId
  })
  return { ...result, code }
}

export function codeForReadinessStatus(
  status: 'no-active-terminal' | 'no-agent' | 'permission' | 'status-unavailable'
): ActiveAgentNotesSendFailureCode {
  switch (status) {
    case 'no-active-terminal':
      return 'no-inventory-match'
    case 'no-agent':
      return 'no-agent'
    case 'permission':
      return 'agent-permission'
    case 'status-unavailable':
      return 'status-unavailable'
  }
}

export function runtimeFailureCode(error: unknown): ActiveAgentNotesSendFailureCode | null {
  return TERMINAL_RUNTIME_FAILURE_CODES.find((code) => hasRuntimeRpcErrorCode(error, code)) ?? null
}

export function runtimeFailureFallbackCode(error: unknown): ActiveAgentNotesSendFailureCode {
  return isTimeoutError(error) ? 'runtime-timeout' : 'runtime-unverifiable'
}

function isTimeoutError(error: unknown): boolean {
  if (hasRuntimeRpcErrorCode(error, 'runtime_timeout')) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('timeout')
}

function codeForStatus(
  status: Exclude<ActiveAgentNotesSendResult['status'], 'sent' | 'empty'>
): ActiveAgentNotesSendFailureCode {
  switch (status) {
    case 'no-active-terminal':
      return 'no-inventory-match'
    case 'no-agent':
      return 'no-agent'
    case 'permission':
      return 'agent-permission'
    case 'status-unavailable':
      return 'status-unavailable'
    case 'not-ready':
      return 'terminal_wait_timeout'
    case 'not-writable':
      return 'terminal-send-refused'
    case 'partial-submit-failed':
      return 'submit-send-error'
  }
}
