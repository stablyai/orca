import type { PtyInputSource } from './pty-input-source'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

export const PTY_PRECONNECT_INPUT_MAX_ENTRIES = 1024
// Budget retained paste across transport/handoff copies and up to 64 deferred splits, independently of the single-write ceiling.
export const PTY_PRECONNECT_INPUT_MAX_CODE_UNITS = 4 * CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS

import {
  createBufferedInput,
  createAcceptedBufferedInput,
  notifyRetainedInput,
  settleBufferedInput,
  withdrawBufferedInputs,
  partitionScopedBufferedInputs,
  writeAcceptedBufferedInput,
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
  discardUnscoped: (onWithdrawn?: () => void) => boolean
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
    if (index !== -1) {
      pending.splice(index, 1)
      pendingCodeUnits -= input.data.length
    } else if (activeAcceptedInput !== input) {
      return
    }
    if (activeAcceptedInput === input) {
      activeAcceptedInput = null
    }
    settleBufferedInput(input, false)
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
    stopFlush()
    withdrawBufferedInputs([...(inFlight ? [inFlight] : []), ...dropped])
  }

  const runFlush = async (writer: PreconnectInputWriter): Promise<void> => {
    let failed = false
    let failure: unknown
    const settle = (input: BufferedInput, accepted: boolean): void => {
      try {
        settleBufferedInput(input, accepted)
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
    try {
      while (buffering && pending.length > 0) {
        const input = pending.shift()
        if (!input) {
          continue
        }
        pendingCodeUnits -= input.data.length
        if (input.source && !input.source.isCurrent()) {
          settle(input, false)
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
          settle(input, false)
          clear()
          return
        }
        if (input.kind === 'accepted') {
          let accepted: boolean | null = null
          try {
            accepted = await writeAcceptedBufferedInput(input, writer, flushStopped)
          } catch {
            const withdrawn = !input.resolve
            settle(input, false)
            if (withdrawn) {
              continue
            }
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
          if (!input.resolve) {
            continue
          }
          if (!buffering || accepted === null) {
            settle(input, false)
            return
          }
          settle(input, accepted)
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
      failed = true
      failure = error
      try {
        clear()
      } catch (cleanupError) {
        failure = cleanupError
      }
    } finally {
      if (failed) {
        throw failure
      }
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
      if (options?.signal?.aborted) {
        return Promise.resolve(false)
      }
      const { input, completion, onAbort } = createAcceptedBufferedInput(
        data,
        inputKind,
        options,
        source,
        withdraw
      )
      if (!retain(input)) {
        settleBufferedInput(input, false)
        return completion
      }
      options?.signal?.addEventListener('abort', onAbort, { once: true })
      notifyRetainedInput(onRetained, input)
      return completion
    },
    flush,
    discardUnscoped: (onWithdrawn) => {
      const partition = partitionScopedBufferedInputs(pending, activeAcceptedInput)
      pending = partition.retained
      pendingCodeUnits = partition.retainedCodeUnits
      activeAcceptedInput = partition.active
      if (pending.length === 0 && activeAcceptedInput === null) {
        buffering = false
        stopFlush()
      }
      withdrawBufferedInputs(partition.dropped, onWithdrawn)
      return partition.droppedTyping
    },
    clear
  }
}
