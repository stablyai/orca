import type { IDisposable } from '@xterm/xterm'
import type { TerminalLinkCommit } from './terminal-link-activation-operation'

export type TerminalLinkPtyMouseSuppression = IDisposable & {
  commit: TerminalLinkCommit
  bindSource: (source: InputBinding | null) => void
  invalidateSource: () => void
  reset: () => void
  recordKeyEvent: (event: KeyboardEvent) => void
  commitPointer: (event: MouseEvent, candidate: string, operation: () => void) => boolean
  commitKeyboard: (event: MouseEvent, operation: () => void) => boolean
  handlePtyInput: (
    data: string,
    forward: (data: string) => void,
    userInput?: boolean,
    qualify?: (data: string, userInput: boolean) => boolean
  ) => void
}

export type InputBinding = {
  isCurrent: () => boolean
  qualify?: (data: string, userInput: boolean) => boolean
  user: (data: string) => void
  unclassified: (data: string) => void
}
export type QualifiedInput = { data: string; forward: (data: string) => void }
export type Transaction = {
  source: InputBinding
  candidate: string
  down: MouseEvent
  up: MouseEvent | null
  dispatch: MouseEvent
  direct: boolean
  state: 'pending' | 'consumed' | 'revoked-forward' | 'revoked-consumed'
  frames: QualifiedInput[] | null
}

export function sameNativeMouseEvent(a: MouseEvent, b: MouseEvent): boolean {
  return (
    a.timeStamp === b.timeStamp &&
    a.button === b.button &&
    a.buttons === b.buttons &&
    a.ctrlKey === b.ctrlKey &&
    a.metaKey === b.metaKey &&
    a.altKey === b.altKey &&
    a.shiftKey === b.shiftKey &&
    a.clientX === b.clientX &&
    a.clientY === b.clientY &&
    a.screenX === b.screenX &&
    a.screenY === b.screenY
  )
}

export function forwardTerminalLinkFrames(frames: QualifiedInput[] | null): void {
  let failure: unknown
  for (const frame of frames ?? []) {
    try {
      frame.forward(frame.data)
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== undefined) {
    throw failure
  }
}
