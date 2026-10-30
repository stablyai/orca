import type { PtyInputSource } from './pty-input-source'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

export const PTY_PRECONNECT_INPUT_MAX_ENTRIES = 1024
// Budget retained paste across transport/handoff copies and up to 64 deferred splits, independently of the single-write ceiling.
export const PTY_PRECONNECT_INPUT_MAX_CODE_UNITS = 4 * CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS

import {
  createBufferedInput,
  notifyRetainedInput,
  type PtyPreconnectInputEntry,
  type AcceptedInputOptions,
  type BufferedInput,
  type PreconnectInputWriter
} from './pty-preconnect-input-entry'
export type {
  PtyPreconnectInputKind,
  PtyPreconnectInputEntry,
  AcceptedInputOptions,
  PreconnectInputWriter
} from './pty-preconnect-input-entry'

export type PtyPreconnectInputBuffer = {
  isBuffering: () => boolean
  hasPendingInput: () => boolean
  enqueue: (
    data: string,
    kind: 'ordinary' | 'immediate',
    inputKind: TerminalInputKind,
    onRetained?: (entry: PtyPreconnectInputEntry) => void,
    source?: PtyInputSource
  ) => boolean
  enqueueAccepted: (
    data: string,
    inputKind: TerminalInputKind,
    onRetained?: (entry: PtyPreconnectInputEntry) => void,
    options?: AcceptedInputOptions,
    source?: PtyInputSource
  ) => Promise<boolean>
  flush: (writer: PreconnectInputWriter) => Promise<void>
  clear: () => void
  discardUnscoped: () => boolean
}

export type PtyPreconnectInputBufferOptions = {
  /** Retain outage input by coalescing keystrokes; renewed outage pauses release with remaining entries preserved. */
  recoveryHold?: boolean
}

export function createPtyPreconnectInputBuffer(
  initialEntries: readonly PtyPreconnectInputEntry[] = [],
  options: PtyPreconnectInputBufferOptions = {}
): PtyPreconnectInputBuffer {
  let pending: BufferedInput[] = []
  let pendingCodeUnits = 0
  let buffering = true
  let activeAcceptedInput: BufferedInput | null = null
  let activeFlush: Promise<void> | null = null
  let stopFlush!: () => void
  const flushStopped = new Promise<void>((resolve) => {
    stopFlush = resolve
  })

  const retain = (input: BufferedInput): boolean => {
    const activeEntries = activeAcceptedInput ? 1 : 0
    const activeCodeUnits = activeAcceptedInput?.data.length ?? 0
    const tail = pending.at(-1)
    if (
      options.recoveryHold &&
      buffering &&
      input.kind === 'ordinary' &&
      tail?.kind === 'ordinary' &&
      tail.inputKind === input.inputKind &&
      tail.source === input.source &&
      input.data.length <= PTY_PRECONNECT_INPUT_MAX_CODE_UNITS - pendingCodeUnits - activeCodeUnits
    ) {
      tail.data += input.data
      pendingCodeUnits += input.data.length
      return true
    }
    if (
      !buffering ||
      pending.length + activeEntries >= PTY_PRECONNECT_INPUT_MAX_ENTRIES ||
      input.data.length > PTY_PRECONNECT_INPUT_MAX_CODE_UNITS - pendingCodeUnits - activeCodeUnits
    ) {
      return false
    }
    pending.push(input)
    pendingCodeUnits += input.data.length
    return true
  }
  // Why: a caller that timed out already reported the write failed; delivering it later would land a stray fragment.
  const withdraw = (input: BufferedInput): void => {
    const index = pending.indexOf(input)
    if (index === -1) {
      return
    }
    pending.splice(index, 1)
    pendingCodeUnits -= input.data.length
    input.resolve?.(false)
  }
  // Seeded entries already belong to predecessor handoff; do not report them back as newly typed.
  for (const entry of initialEntries) {
    retain(
      createBufferedInput(
        entry.data,
        entry.kind,
        entry.inputKind,
        undefined,
        undefined,
        entry.source
      )
    )
  }
  const clear = (): void => {
    const dropped = pending
    pending = []
    pendingCodeUnits = 0
    buffering = false
    const inFlight = activeAcceptedInput
    activeAcceptedInput = null
    inFlight?.resolve?.(false)
    for (const input of dropped) {
      input.resolve?.(false)
    }
    stopFlush()
  }

  const runFlush = async (writer: PreconnectInputWriter): Promise<void> => {
    try {
      while (buffering && pending.length > 0) {
        const input = pending.shift()
        if (!input) {
          continue
        }
        pendingCodeUnits -= input.data.length
        if (input.source && !input.source.isCurrent()) {
          input.resolve?.(false)
          continue
        }
        if (input.kind === 'accepted') {
          activeAcceptedInput = input
        }
        if (buffering && options.recoveryHold && !writer.isCurrent()) {
          pending.unshift(input)
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
                      input.signal ? { signal: input.signal } : undefined,
                      input.source
                    )
                  : writer.sendInput(input.data, input.inputKind, input.source)
              ),
              flushStopped.then(() => null)
            ])
          } catch {
            input.resolve?.(false)
            if (input.source && !input.source.isCurrent()) {
              continue
            }
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
          if (
            !accepted &&
            !(input.source && !input.source.isCurrent()) &&
            !input.signal?.aborted &&
            !writer.continuesAfterFailedWrite?.()
          ) {
            clear()
            return
          }
          continue
        }
        let accepted: boolean
        try {
          accepted =
            input.kind === 'immediate'
              ? writer.sendInputImmediate(input.data, input.source)
              : writer.sendInput(input.data, input.inputKind, input.source)
        } catch (error) {
          if (input.source && !input.source.isCurrent()) {
            continue
          }
          throw error
        }
        if (!accepted && !(input.source && !input.source.isCurrent())) {
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

  return {
    isBuffering: () => buffering,
    hasPendingInput: () => pending.length > 0 || activeAcceptedInput !== null,
    enqueue(data, kind, inputKind, onRetained, source) {
      const input = createBufferedInput(data, kind, inputKind, undefined, undefined, source)
      const retained = retain(input)
      if (retained) {
        notifyRetainedInput(onRetained, input)
      }
      return retained
    },
    enqueueAccepted(data, inputKind, onRetained, options, source) {
      return new Promise<boolean>((resolve) => {
        const signal = options?.signal
        if (signal?.aborted) {
          resolve(false)
          return
        }
        const onAbort = (): void => withdraw(input)
        // Why: a long-lived caller signal would otherwise pin every settled input through its listener.
        const settle = (accepted: boolean): void => {
          try {
            signal?.removeEventListener('abort', onAbort)
          } finally {
            resolve(accepted)
          }
        }
        const input = createBufferedInput(data, 'accepted', inputKind, settle, signal, source)
        if (!retain(input)) {
          resolve(false)
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        notifyRetainedInput(onRetained, input)
      })
    },
    flush,
    discardUnscoped: () => {
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
      pending = retained
      pendingCodeUnits = retainedCodeUnits
      let failure: unknown
      for (const input of dropped) {
        try {
          input.resolve?.(false)
        } catch (error) {
          failure ??= error
        }
      }
      if (failure !== undefined) {
        throw failure
      }
      return droppedTyping
    },
    clear
  }
}
