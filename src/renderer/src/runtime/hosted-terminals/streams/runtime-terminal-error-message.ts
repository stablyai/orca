import {
  parseAccountRestartReceipt,
  formatAccountRestartFailure
} from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import './registry/remote-runtime-terminal-multiplexer-registry'

export function runtimeTerminalErrorMessage(error: unknown): string {
  if (error instanceof RuntimeRpcCallError) {
    const data = error.response.error.data
    const receipt = parseAccountRestartReceipt(
      data && typeof data === 'object' && 'accountRestart' in data ? data.accountRestart : undefined
    )
    return receipt ? formatAccountRestartFailure(error.message, receipt) : error.message
  }
  return error instanceof Error ? error.message : String(error)
}
