import type { PtyTransport } from './pty-transport'
import type { PtyInputOperationOptions } from './pty-transport-types'

type TerminalPastePtyWriter = Pick<
  PtyTransport,
  'sendInput' | 'sendInputAccepted' | 'retireInputOperation'
>

export function writeTerminalPastePtyInput(
  transport: TerminalPastePtyWriter | undefined,
  data: string,
  options?: PtyInputOperationOptions
): boolean | Promise<boolean> {
  if (!transport) {
    return false
  }
  // Why: paste chunking must respect PTY backpressure. sendInput only queues
  // local writes, while sendInputAccepted resolves after the PTY accepts them.
  const result = options
    ? (transport.sendInputAccepted?.(data, options) ?? transport.sendInput(data, options))
    : (transport.sendInputAccepted?.(data) ?? transport.sendInput(data))
  // A synchronous sendInput result only means queue admission; retiring its ID
  // before the remote relay settles would reopen the duplicate-write window.
  if (!options?.operationId || !transport.retireInputOperation || !isPromiseLike(result)) {
    return result
  }
  return Promise.resolve(result).then((accepted) => {
    if (!accepted) {
      return false
    }
    // Retry-window cleanup must never turn acknowledged input into a retryable write.
    try {
      void Promise.resolve(transport.retireInputOperation?.(options.operationId)).catch(() => {})
    } catch {
      // The provider retains settlement state for recovery when cleanup is unavailable.
    }
    return true
  })
}

function isPromiseLike(value: boolean | Promise<boolean>): value is Promise<boolean> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
