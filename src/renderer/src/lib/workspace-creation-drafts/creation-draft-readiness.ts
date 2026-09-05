import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-types'

/** Uses host-retained state so mounting xterm cannot consume our readiness evidence. */
export async function isCreationDraftInputReady(terminalHandle: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
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
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000)
      })
    ])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
