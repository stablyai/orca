import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

export const PTY_PRECONNECT_INPUT_MAX_ENTRIES = 1024
// Why: a retention budget, not the 16MB single-write ceiling. The deferral lasts
// under a second and this is held twice (transport buffer + handoff record) across
// up to 64 deferred splits, so size it at a few clipboard-sized pastes.
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
}

type PreconnectInputWriter = {
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
}

export type PtyPreconnectInputBufferOptions = {
  /**
   * Holds input across a remote outage: consecutive keystrokes merge (minutes of typing must not
   * hit the entry cap), and a release interrupted by another outage pauses with the rest kept
   * for the next release instead of dropping it.
   */
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
    const index = pending.indexOf(input)
    if (index === -1) {
      return
    }
    pending.splice(index, 1)
    pendingCodeUnits -= input.data.length
    input.resolve?.(false)
  }
  const notifyRetained = (
    onRetained: ((entry: PtyPreconnectInputEntry) => void) | undefined,
    input: BufferedInput
  ): void => {
    try {
      onRetained?.({ data: input.data, kind: input.kind, inputKind: input.inputKind })
    } catch {
      // Handoff capture is advisory; a callback failure must not reject input admission.
    }
  }

  // Seeded entries came from a predecessor transport and must not be reported
  // back to that predecessor's handoff owner as newly typed input.
  for (const entry of initialEntries) {
    retain(createInput(entry.data, entry.kind, entry.inputKind))
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

  return {
    isBuffering: () => buffering,
    hasPendingInput: () => pending.length > 0 || activeAcceptedInput !== null,
    enqueue(data, kind, inputKind, onRetained) {
      const input = createInput(data, kind, inputKind)
      const retained = retain(input)
      if (retained) {
        notifyRetained(onRetained, input)
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
        const input = createInput(data, 'accepted', inputKind, resolve, signal)
        if (!retain(input)) {
          resolve(false)
          return
        }
        signal?.addEventListener('abort', () => withdraw(input), { once: true })
        notifyRetained(onRetained, input)
      })
    },
    flush,
    clear
  }
}
