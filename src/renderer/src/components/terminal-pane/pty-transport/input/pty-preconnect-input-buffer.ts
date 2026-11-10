import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../../../shared/clipboard-text'
import type { TerminalInputKind } from '../../../../../../shared/terminal/input/terminal-input-kind'
import {
  closePasteGates,
  notifyRetainedPreconnectInput,
  openPasteGateOn,
  placeBeforeOpenPasteGate,
  takePasteGateHead,
  type PasteGate,
  type PasteGateSlots,
  type PtyPreconnectPasteHold
} from './pty-preconnect-paste-gate'

export type { PtyPreconnectPasteHold }

export const PTY_PRECONNECT_INPUT_MAX_ENTRIES = 1024
// Budget retained paste across transport/handoff copies and up to 64 deferred splits, independently of the single-write ceiling.
export const PTY_PRECONNECT_INPUT_MAX_CODE_UNITS = 4 * CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS

export type PtyPreconnectInputKind = 'ordinary' | 'immediate' | 'accepted'

/** Input retained while a pane waits for its first PTY connection. */
export type PtyPreconnectInputEntry = {
  data: string
  kind: PtyPreconnectInputKind
  inputKind: TerminalInputKind
}

/** Lets the caller of an acknowledged write give it up; a held or journaled copy is then never sent. */
export type AcceptedInputOptions = { signal?: AbortSignal }

type BufferedInput = PtyPreconnectInputEntry & {
  resolve?: (accepted: boolean) => void
  signal?: AbortSignal
  pasteGate?: PasteGate
}

export type PreconnectInputWriter = {
  isCurrent: () => boolean
  sendInput: (data: string, inputKind: TerminalInputKind) => boolean
  sendInputImmediate: (data: string) => boolean
  sendInputAccepted?: (
    data: string,
    inputKind: TerminalInputKind,
    options?: AcceptedInputOptions
  ) => Promise<boolean>
  /**
   * True when a failed accepted write was withdrawn or of unknown delivery, not a broken link, so
   * the input typed after it still goes (a sequenced remote stream keeps order on its own).
   */
  continuesAfterFailedWrite?: () => boolean
}

export type PtyPreconnectInputBuffer = {
  isBuffering: () => boolean
  hasPendingInput: () => boolean
  enqueue: (
    data: string,
    kind: 'ordinary' | 'immediate',
    inputKind: TerminalInputKind,
    onRetained?: (entry: PtyPreconnectInputEntry) => void
  ) => boolean
  enqueueAccepted: (
    data: string,
    inputKind: TerminalInputKind,
    onRetained?: (entry: PtyPreconnectInputEntry) => void,
    options?: AcceptedInputOptions
  ) => Promise<boolean>
  flush: (writer: PreconnectInputWriter) => Promise<void>
  clear: () => void
  /**
   * Reserve the next queue slot while this buffer is still holding unbound input.
   * Null when not buffering or the entry limit is already full.
   */
  openPasteGate: () => PtyPreconnectPasteHold | null
}

export type PtyPreconnectInputBufferOptions = {
  /** Retain outage input by coalescing keystrokes; renewed outage pauses release with remaining entries preserved. */
  recoveryHold?: boolean
}

export function createPtyPreconnectInputBuffer(
  initialEntries: readonly PtyPreconnectInputEntry[] = [],
  options: PtyPreconnectInputBufferOptions = {}
): PtyPreconnectInputBuffer {
  const slots: PasteGateSlots<BufferedInput> = { pending: [], insertGate: null }
  let pendingCodeUnits = 0
  let buffering = true
  let activeAcceptedInput: BufferedInput | null = null
  let activeFlush: Promise<void> | null = null
  let stopFlush!: () => void
  const flushStopped = new Promise<void>((resolve) => {
    stopFlush = resolve
  })

  const activeCodeUnits = (): number => activeAcceptedInput?.data.length ?? 0
  const withinLimits = (dataLength: number): boolean => {
    const activeEntries = activeAcceptedInput ? 1 : 0
    return (
      buffering &&
      slots.pending.length + activeEntries < PTY_PRECONNECT_INPUT_MAX_ENTRIES &&
      dataLength <= PTY_PRECONNECT_INPUT_MAX_CODE_UNITS - pendingCodeUnits - activeCodeUnits()
    )
  }
  const retain = (input: BufferedInput): boolean => {
    const tail = slots.pending.at(-1)
    if (
      options.recoveryHold &&
      buffering &&
      input.kind === 'ordinary' &&
      tail?.kind === 'ordinary' &&
      !tail.pasteGate &&
      tail.inputKind === input.inputKind &&
      input.data.length <=
        PTY_PRECONNECT_INPUT_MAX_CODE_UNITS - pendingCodeUnits - activeCodeUnits()
    ) {
      tail.data += input.data
      pendingCodeUnits += input.data.length
      return true
    }
    if (!withinLimits(input.data.length)) {
      return false
    }
    slots.pending.push(input)
    pendingCodeUnits += input.data.length
    return true
  }
  const account = (dataLength: number): void => {
    pendingCodeUnits += dataLength
  }
  const place = (input: BufferedInput): boolean =>
    placeBeforeOpenPasteGate(slots, input, input.data.length, withinLimits, retain, account)
  const createInput = (
    data: string,
    kind: PtyPreconnectInputKind,
    inputKind: TerminalInputKind,
    resolve?: BufferedInput['resolve'],
    signal?: AbortSignal
  ): BufferedInput => ({
    data,
    kind,
    inputKind,
    ...(resolve ? { resolve } : {}),
    ...(signal ? { signal } : {})
  })
  // Why: a caller that timed out already reported the write failed; delivering it later would land a stray fragment.
  const withdraw = (input: BufferedInput): void => {
    const index = slots.pending.indexOf(input)
    if (index === -1) {
      return
    }
    slots.pending.splice(index, 1)
    pendingCodeUnits -= input.data.length
    input.resolve?.(false)
  }
  // Seeded entries already belong to predecessor handoff; do not report them back as newly typed.
  for (const entry of initialEntries) {
    retain(createInput(entry.data, entry.kind, entry.inputKind))
  }
  const clear = (): void => {
    const dropped = slots.pending
    slots.pending = []
    pendingCodeUnits = 0
    buffering = false
    slots.insertGate = null
    const inFlight = activeAcceptedInput
    activeAcceptedInput = null
    inFlight?.resolve?.(false)
    closePasteGates(dropped)
    for (const input of dropped) {
      input.resolve?.(false)
    }
    stopFlush()
  }

  const resumeFlush = (writer: PreconnectInputWriter): void => {
    const start = (): void => {
      void flush(writer)
    }
    if (activeFlush) {
      void activeFlush.then(start, start)
      return
    }
    start()
  }

  const runFlush = async (writer: PreconnectInputWriter): Promise<void> => {
    try {
      while (buffering && slots.pending.length > 0) {
        const parked = takePasteGateHead(slots.pending, () => resumeFlush(writer))
        if (parked === 'parked') {
          return
        }
        if (parked === 'skipped') {
          continue
        }
        const input = slots.pending.shift()
        if (!input) {
          continue
        }
        pendingCodeUnits -= input.data.length
        if (input.kind === 'accepted') {
          activeAcceptedInput = input
        }
        if (buffering && options.recoveryHold && !writer.isCurrent()) {
          slots.pending.unshift(input)
          pendingCodeUnits += input.data.length
          activeAcceptedInput = null
          return
        }
        if (!buffering || !writer.isCurrent()) {
          input.resolve?.(false)
          clear()
          return
        }
        if (input.kind === 'accepted') {
          let accepted: boolean | null = null
          try {
            accepted = await Promise.race([
              Promise.resolve(
                writer.sendInputAccepted
                  ? writer.sendInputAccepted(
                      input.data,
                      input.inputKind,
                      input.signal ? { signal: input.signal } : undefined
                    )
                  : writer.sendInput(input.data, input.inputKind)
              ),
              flushStopped.then(() => null)
            ])
          } catch {
            input.resolve?.(false)
            clear()
            return
          } finally {
            if (activeAcceptedInput === input) {
              activeAcceptedInput = null
            }
          }
          if (!buffering || accepted === null) {
            input.resolve?.(false)
            return
          }
          input.resolve?.(accepted)
          // Why not for a withdrawn write: its caller gave up on it alone, not on what was typed after it.
          if (!accepted && !input.signal?.aborted && !writer.continuesAfterFailedWrite?.()) {
            clear()
            return
          }
          continue
        }
        const accepted =
          input.kind === 'immediate'
            ? writer.sendInputImmediate(input.data)
            : writer.sendInput(input.data, input.inputKind)
        if (!accepted) {
          clear()
          return
        }
      }
      buffering = false
      stopFlush()
    } catch (error) {
      clear()
      throw error
    }
  }

  const flush = (writer: PreconnectInputWriter): Promise<void> => {
    if (activeFlush) {
      return activeFlush
    }
    if (!buffering) {
      return Promise.resolve()
    }
    const flushPromise = Promise.resolve().then(() => runFlush(writer))
    activeFlush = flushPromise
    const releaseFlight = (): void => {
      if (activeFlush === flushPromise) {
        activeFlush = null
      }
    }
    void flushPromise.then(releaseFlight, releaseFlight)
    return flushPromise
  }

  const openPasteGate = (): PtyPreconnectPasteHold | null =>
    openPasteGateOn(slots, withinLimits, () => createInput('', 'ordinary', 'driving'))

  return {
    isBuffering: () => buffering,
    hasPendingInput: () =>
      slots.pending.some((input) => !input.pasteGate) || activeAcceptedInput !== null,
    enqueue(data, kind, inputKind, onRetained) {
      const input = createInput(data, kind, inputKind)
      const retained = place(input)
      if (retained) {
        notifyRetainedPreconnectInput(onRetained, input)
      }
      return retained
    },
    enqueueAccepted(data, inputKind, onRetained, options) {
      return new Promise<boolean>((resolve) => {
        const signal = options?.signal
        if (signal?.aborted) {
          resolve(false)
          return
        }
        const onAbort = (): void => withdraw(input)
        // Why: a long-lived caller signal would otherwise pin every settled input through its listener.
        const settle = (accepted: boolean): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve(accepted)
        }
        const input = createInput(data, 'accepted', inputKind, settle, signal)
        if (!place(input)) {
          resolve(false)
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        notifyRetainedPreconnectInput(onRetained, input)
      })
    },
    flush,
    clear,
    openPasteGate
  }
}
