import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-types'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'

/** Uses host-retained state so mounting xterm cannot consume our readiness evidence. */
export async function isCreationDraftInputReady(terminalHandle: string): Promise<boolean> {
  return withTimeout(
    callRuntimeRpc<{ wait: RuntimeTerminalWait }>({ kind: 'local' }, 'terminal.wait', {
      terminal: terminalHandle,
      for: 'tui-idle',
      timeoutMs: 100
    }).then(
      ({ wait }) =>
        wait?.handle === terminalHandle &&
        wait.condition === 'tui-idle' &&
        wait.status === 'running' &&
        wait.satisfied === true &&
        wait.blockedReason === undefined
    ),
    1000,
    false
  )
}
