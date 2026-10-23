import type { TerminalInputKind, TerminalInputOrigin } from '../../../../shared/terminal-input-kind'

export const TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS = 4096
export const PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES = 64
export const PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLY_CODE_UNITS =
  TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS

export type PendingPtyInputWrite = {
  sequence: number
  id: string
  text: string
  replyOnly: boolean
  inputKind: TerminalInputKind
  inputOrigin?: TerminalInputOrigin
  resolveAccepted: ((accepted: boolean) => void) | undefined
  tooLarge: boolean | Promise<boolean>
  chunks?: Iterator<string>
  nextChunk?: string
}

export type PtyInputWriteQueue = {
  enqueue: (
    id: string,
    data: string,
    inputKind: TerminalInputKind,
    inputOrigin?: TerminalInputOrigin
  ) => boolean
  enqueueQueryReply: (id: string, data: string) => boolean
  enqueueAccepted: (
    id: string,
    data: string,
    inputKind: TerminalInputKind,
    inputOrigin?: TerminalInputOrigin
  ) => Promise<boolean>
  waitForDrain: () => Promise<void>
  clear: () => void
}

export type PtyInputWriteQueueDeps = {
  isWritable: (id: string) => boolean
  write: (
    id: string,
    data: string,
    inputKind: TerminalInputKind,
    inputOrigin?: TerminalInputOrigin
  ) => void
  writeAccepted?: (
    id: string,
    data: string,
    inputKind: TerminalInputKind,
    inputOrigin?: TerminalInputOrigin
  ) => Promise<boolean>
  yieldBetweenWrites?: () => Promise<void>
  onDrainFailure?: (id: string) => void
}

export function isCoalesciblePtyInput(input: PendingPtyInputWrite): boolean {
  return (
    input.text.length <= TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS &&
    !input.replyOnly &&
    !input.resolveAccepted
  )
}

// Why: one cancel per in-flight write rather than `.then()` on a queue-lifetime
// promise — those reactions are retained until that promise settles, so a
// long-lived pane accumulated one record per acknowledged write (Esc, Ctrl+C).
export async function writeAcceptedPtyInputChunk(
  deps: PtyInputWriteQueueDeps,
  pendingAcceptedCancels: Set<() => void>,
  item: PendingPtyInputWrite,
  data: string
): Promise<boolean> {
  let cancel = (): void => undefined
  const cancelled = new Promise<boolean>((resolve) => {
    cancel = () => resolve(false)
  })
  // Registered before the write starts so a clear() inside a synchronous
  // writeAccepted callback still unblocks this race.
  pendingAcceptedCancels.add(cancel)
  try {
    return await Promise.race([
      cancelled,
      Promise.resolve(
        (item.inputOrigin
          ? deps.writeAccepted?.(item.id, data, item.inputKind, item.inputOrigin)
          : deps.writeAccepted?.(item.id, data, item.inputKind)) ?? false
      ).catch(() => false)
    ])
  } finally {
    pendingAcceptedCancels.delete(cancel)
  }
}
