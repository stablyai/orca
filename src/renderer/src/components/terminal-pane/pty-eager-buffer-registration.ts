import { ensurePtyDispatcher, registerEagerPtyBuffer, type EagerPtyHandle } from './pty-dispatcher'
import { capturePreHandlerPtyEventCursor } from './pty-pre-handler-buffer'

export type EagerPtyBufferRegistration = (
  ptyId: string,
  onExit: (ptyId: string, code: number) => void
) => EagerPtyHandle

export function captureEagerPtyBufferRegistration(
  observePreSubscriptionData?: (data: string) => void
): EagerPtyBufferRegistration {
  // Why: pty:exit is not boot-gated like pty:data. Attach before spawn and
  // retain one cursor so reused ids cannot inherit an older lifecycle.
  ensurePtyDispatcher()
  const afterCursor = capturePreHandlerPtyEventCursor()
  return (ptyId, onExit) =>
    registerEagerPtyBuffer(ptyId, onExit, afterCursor, observePreSubscriptionData)
}
