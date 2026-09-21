import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'

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
}

type BufferedInput = PtyPreconnectInputEntry & {
  resolve?: (accepted: boolean) => void
}

type PreconnectInputWriter = {
  isCurrent: () => boolean
  sendInput: (data: string) => boolean
  sendInputImmediate: (data: string) => boolean
  sendInputAccepted?: (data: string) => Promise<boolean>
}

export type PtyPreconnectInputBuffer = {
  isBuffering: () => boolean
  enqueue: (
    data: string,
    kind: 'ordinary' | 'immediate',
    onRetained?: (entry: PtyPreconnectInputEntry) => void
  ) => boolean
  enqueueAccepted: (
    data: string,
    onRetained?: (entry: PtyPreconnectInputEntry) => void
  ) => Promise<boolean>
  flush: (writer: PreconnectInputWriter) => Promise<void>
  clear: () => void
}

export function createPtyPreconnectInputBuffer(
  initialEntries: readonly PtyPreconnectInputEntry[] = []
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
    resolve?: BufferedInput['resolve']
  ): BufferedInput => ({ data, kind, ...(resolve ? { resolve } : {}) })
  const notifyRetained = (
    onRetained: ((entry: PtyPreconnectInputEntry) => void) | undefined,
    input: BufferedInput
  ): void => {
    try {
      onRetained?.({ data: input.data, kind: input.kind })
    } catch {
      // Handoff capture is advisory; a callback failure must not reject input admission.
    }
  }

  // Seeded entries came from a predecessor transport and must not be reported
  // back to that predecessor's handoff owner as newly typed input.
  for (const entry of initialEntries) {
    retain(createInput(entry.data, entry.kind))
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
                  ? writer.sendInputAccepted(input.data)
                  : writer.sendInput(input.data)
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
          if (!accepted) {
            clear()
            return
          }
          continue
        }
        const accepted =
          input.kind === 'immediate'
            ? writer.sendInputImmediate(input.data)
            : writer.sendInput(input.data)
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
    enqueue(data, kind, onRetained) {
      const input = createInput(data, kind)
      const retained = retain(input)
      if (retained) {
        notifyRetained(onRetained, input)
      }
      return retained
    },
    enqueueAccepted(data, onRetained) {
      return new Promise<boolean>((resolve) => {
        const input = createInput(data, 'accepted', resolve)
        if (!retain(input)) {
          resolve(false)
          return
        }
        notifyRetained(onRetained, input)
      })
    },
    flush,
    clear
  }
}
