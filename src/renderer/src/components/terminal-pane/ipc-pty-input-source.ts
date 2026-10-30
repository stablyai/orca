import { createPtyInputSourceBinding } from './pty-input-source'
import type { createPtyInputWriteQueue } from './pty-input-write-queue'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

/** Cache the explicit-ID queue capability once per IPC source lifetime. */
export function createIpcPtyInputSource(args: {
  connectionId: string | undefined
  inputWriteQueue: ReturnType<typeof createPtyInputWriteQueue>
  isConnected: () => boolean
}) {
  const { connectionId, inputWriteQueue, isConnected } = args
  return createPtyInputSourceBinding<{ id: string; generation: number }>({
    same: (a, b) => a.id === b.id && a.generation === b.generation,
    refine: (_, next) => next,
    create: (endpoint, isCurrent) => {
      const id = endpoint().id
      return {
        ptyId: id,
        isCurrent,
        sendInput: (data, kind) => isCurrent() && inputWriteQueue.enqueue(id, data, kind),
        sendInputImmediate: (data) => isCurrent() && inputWriteQueue.enqueueQueryReply(id, data),
        ...(connectionId
          ? {}
          : {
              sendInputAccepted: async (data: string, kind: TerminalInputKind) =>
                isCurrent() &&
                (await inputWriteQueue.enqueueAccepted(id, data, kind)) &&
                isCurrent()
            }),
        claimViewport: (cols, rows) => {
          if (!isCurrent() || !isConnected()) {
            return false
          }
          window.api.pty.claimViewport(id, cols, rows)
          return true
        }
      }
    }
  })
}
