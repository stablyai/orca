import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import './registry/remote-runtime-terminal-multiplexer-registry'

export function runtimeTerminalErrorMessage(error: unknown): string {
  if (error instanceof RuntimeRpcCallError) {
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}
