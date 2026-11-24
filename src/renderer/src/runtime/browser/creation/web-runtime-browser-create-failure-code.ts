// Store-free so link routing can name a failure without importing browser creation.
import { readRuntimeRpcErrorCode } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'

export const DEFINITIVE_BROWSER_CREATE_FAILURE_CODES = [
  'browser_error',
  'capability_unsupported',
  'invalid_argument',
  'invalid_params',
  'method_not_found',
  'runtime_rpc_queue_overloaded',
  'selector_ambiguous',
  'selector_not_found',
  'unauthorized'
] as const

// Codes a browser create can fail with; any other host-supplied code is logged as other_code.
const REPORTED_BROWSER_CREATE_FAILURE_CODES = [
  ...DEFINITIVE_BROWSER_CREATE_FAILURE_CODES,
  'browser_unavailable',
  'browser_profile_unavailable',
  'browser_owner_unavailable',
  'browser_command_unavailable',
  'browser_tab_not_found',
  'browser_timeout',
  'runtime_compat_block',
  'runtime_unavailable',
  'runtime_error'
]

/** The failure's known machine code (never its message, which can name the URL). */
export function browserCreateFailureCode(error: unknown): string | null {
  return readRuntimeRpcErrorCode(error, REPORTED_BROWSER_CREATE_FAILURE_CODES)
}
