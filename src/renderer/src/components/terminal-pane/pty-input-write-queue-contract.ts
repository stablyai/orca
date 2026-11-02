import type { TerminalInputCall } from './terminal-input-call'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

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
  resolveAccepted: ((accepted: boolean) => void) | undefined
  call?: TerminalInputCall
  eligible?: boolean
  tooLarge: boolean | Promise<boolean>
  chunks?: Iterator<string>
  nextChunk?: string
}

export type PtyInputWriteQueue = {
  enqueue: (
    id: string,
    data: string,
    inputKind: TerminalInputKind,
    call?: TerminalInputCall
  ) => boolean
  enqueueQueryReply: (id: string, data: string) => boolean
  enqueueAccepted: (
    id: string,
    data: string,
    inputKind: TerminalInputKind,
    call?: TerminalInputCall
  ) => Promise<boolean>
  waitForDrain: () => Promise<void>
  clear: () => void
}

export type PtyInputWriteQueueDeps = {
  isWritable: (id: string) => boolean
  write: (id: string, data: string, inputKind: TerminalInputKind) => void
  writeAccepted?: (id: string, data: string, inputKind: TerminalInputKind) => Promise<boolean>
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

export function notifyEligiblePtyInputWrite(item: PendingPtyInputWrite): void {
  if (!item.eligible && !item.resolveAccepted && item.tooLarge === false) {
    item.eligible = true
    item.call?.onEligible(item.id)
  }
}
