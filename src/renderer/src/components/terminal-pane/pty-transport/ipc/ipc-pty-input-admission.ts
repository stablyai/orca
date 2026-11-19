import { getTerminalNoticeLifetime } from '../../provider-notices/terminal-notice-lifetime'
import { createPtyInputWriteQueue } from '../input/pty-input-write-queue'
import type {
  PtyInputWriteQueue,
  PtyInputWriteQueueDeps
} from '../input/pty-input-write-queue-contract'
import type { IpcPtyTransportOptions } from '../pty-transport-types'
import type { TerminalInputKind } from '../../../../../../shared/terminal/input/terminal-input-kind'

export function canSendIpcPtyInput(
  opts: IpcPtyTransportOptions,
  id: string | null,
  kind: TerminalInputKind
): boolean {
  return (
    opts.canSendInput?.(id, kind, id ? getTerminalNoticeLifetime(id)?.incarnationId : null) !==
    false
  )
}

/** Recheck after async write validation as well as before buffering keyboard input. */
export function createIpcPtyInputWriteQueue(
  opts: IpcPtyTransportOptions,
  deps: Pick<PtyInputWriteQueueDeps, 'isWritable' | 'onDrainFailure'>
): PtyInputWriteQueue {
  return createPtyInputWriteQueue({
    ...deps,
    write: (id, data, kind) => {
      if (canSendIpcPtyInput(opts, id, kind)) {
        window.api.pty.write(id, data, kind)
      }
    },
    writeAccepted: (id, data, kind) =>
      canSendIpcPtyInput(opts, id, kind)
        ? window.api.pty.writeAccepted(id, data, kind)
        : Promise.resolve(false)
  })
}
