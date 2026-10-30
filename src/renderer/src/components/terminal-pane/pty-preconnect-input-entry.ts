import type { PtyInputSource } from './pty-input-source'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

export type PtyPreconnectInputKind = 'ordinary' | 'immediate' | 'accepted'

/** Input retained while a pane waits for its first PTY connection. */
export type PtyPreconnectInputEntry = {
  data: string
  kind: PtyPreconnectInputKind
  inputKind: TerminalInputKind
  source?: PtyInputSource
}

/** Lets the caller of an acknowledged write give it up; a held or journaled copy is then never sent. */
export type AcceptedInputOptions = { signal?: AbortSignal }

export type BufferedInput = PtyPreconnectInputEntry & {
  resolve?: (accepted: boolean) => void
  signal?: AbortSignal
  /** The existing accepted waiter also wakes a flush when this entry is withdrawn. */
  completion?: Promise<boolean>
}

export type PreconnectInputWriter = {
  isCurrent: () => boolean
  sendInput: (data: string, inputKind: TerminalInputKind, source?: PtyInputSource) => boolean
  sendInputImmediate: (data: string, source?: PtyInputSource) => boolean
  sendInputAccepted?: (
    data: string,
    inputKind: TerminalInputKind,
    options?: AcceptedInputOptions,
    source?: PtyInputSource
  ) => Promise<boolean>
  /**
   * True when a failed accepted write was withdrawn or of unknown delivery, not a broken link, so
   * the input typed after it still goes (a sequenced remote stream keeps order on its own).
   */
  continuesAfterFailedWrite?: () => boolean
}

export const createBufferedInput = (
  data: string,
  kind: PtyPreconnectInputKind,
  inputKind: TerminalInputKind,
  resolve?: BufferedInput['resolve'],
  signal?: AbortSignal,
  source?: PtyInputSource
): BufferedInput => ({
  data,
  kind,
  inputKind,
  ...(source ? { source } : {}),
  ...(resolve ? { resolve } : {}),
  ...(signal ? { signal } : {})
})

export const notifyRetainedInput = (
  onRetained: ((entry: PtyPreconnectInputEntry) => void) | undefined,
  input: BufferedInput
): void => {
  try {
    onRetained?.({
      data: input.data,
      kind: input.kind,
      inputKind: input.inputKind,
      ...(input.source ? { source: input.source } : {})
    })
  } catch {
    // Handoff capture is advisory; a callback failure must not reject input admission.
  }
}

export function settleBufferedInput(input: BufferedInput, accepted: boolean): void {
  const resolve = input.resolve
  input.resolve = undefined
  resolve?.(accepted)
}

export function createAcceptedBufferedInput(
  data: string,
  inputKind: TerminalInputKind,
  options: AcceptedInputOptions | undefined,
  source: PtyInputSource | undefined,
  withdraw: (input: BufferedInput) => void
): { input: BufferedInput; completion: Promise<boolean>; onAbort: () => void } {
  const { promise: completion, resolve } = Promise.withResolvers<boolean>()
  const signal = options?.signal
  const onAbort = (): void => withdraw(input)
  const settle = (accepted: boolean): void => {
    try {
      signal?.removeEventListener('abort', onAbort)
    } finally {
      resolve(accepted)
    }
  }
  const input = createBufferedInput(data, 'accepted', inputKind, settle, signal, source)
  input.completion = completion
  return { input, completion, onAbort }
}

export function partitionScopedBufferedInputs(
  pending: BufferedInput[],
  active: BufferedInput | null
): {
  retained: BufferedInput[]
  retainedCodeUnits: number
  active: BufferedInput | null
  dropped: BufferedInput[]
  droppedTyping: boolean
} {
  const retained: BufferedInput[] = []
  const dropped: BufferedInput[] = []
  let retainedCodeUnits = 0
  let droppedTyping = false
  for (const input of pending) {
    if (!input.source || !input.source.isCurrent()) {
      droppedTyping ||= !input.source && input.inputKind === 'driving'
      dropped.push(input)
    } else {
      retained.push(input)
      retainedCodeUnits += input.data.length
    }
  }
  if (active && (!active.source || !active.source.isCurrent())) {
    droppedTyping ||= !active.source && active.inputKind === 'driving'
    dropped.push(active)
    active = null
  }
  return { retained, retainedCodeUnits, active, dropped, droppedTyping }
}

export function withdrawBufferedInputs(
  inputs: BufferedInput[],
  beforeSettlement?: () => void
): void {
  let failure: unknown
  try {
    beforeSettlement?.()
  } catch (error) {
    failure = error
  }
  for (const input of inputs) {
    try {
      settleBufferedInput(input, false)
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== undefined) {
    throw failure
  }
}

export function writeAcceptedBufferedInput(
  input: BufferedInput,
  writer: PreconnectInputWriter,
  flushStopped: Promise<void>
): Promise<boolean | null> {
  return Promise.race([
    Promise.resolve(
      writer.sendInputAccepted
        ? writer.sendInputAccepted(
            input.data,
            input.inputKind,
            input.signal ? { signal: input.signal } : undefined,
            input.source
          )
        : writer.sendInput(input.data, input.inputKind, input.source)
    ),
    ...(input.completion ? [input.completion] : []),
    flushStopped.then(() => null)
  ])
}
