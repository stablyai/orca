/** Marker that keeps later keystrokes behind a paste whose bytes are not in the queue yet. */
export type PasteGate = {
  closed: boolean
  /** Set when flush reaches this marker before the paste bytes exist. */
  resume?: () => void
}

export type PasteGatedInput = {
  pasteGate?: PasteGate
}

/** A clipboard paste slot opened before the read, so later keystrokes stay behind it. */
export type PtyPreconnectPasteHold = {
  insertIncoming: <T>(run: () => T) => T
  close: () => void
}

export type PasteGateSlots<T extends PasteGatedInput> = {
  pending: T[]
  insertGate: T | null
}

/** Handoff capture is advisory; a callback failure must not reject input admission. */
export function notifyRetainedPreconnectInput<TKind extends string, TInputKind extends string>(
  onRetained: ((entry: { data: string; kind: TKind; inputKind: TInputKind }) => void) | undefined,
  input: { data: string; kind: TKind; inputKind: TInputKind }
): void {
  try {
    onRetained?.({ data: input.data, kind: input.kind, inputKind: input.inputKind })
  } catch {
    // The caller already admitted the input. Reporting the copy must not undo that.
  }
}

export function closePasteGates(inputs: readonly PasteGatedInput[]): void {
  for (const input of inputs) {
    if (!input.pasteGate) {
      continue
    }
    input.pasteGate.closed = true
    input.pasteGate.resume = undefined
  }
}

// Keys typed while a paste is being read stay behind its marker; the paste bytes splice in front.
export function placeBeforeOpenPasteGate<T extends PasteGatedInput>(
  slots: PasteGateSlots<T>,
  input: T,
  dataLength: number,
  withinLimits: (dataLength: number) => boolean,
  retain: (input: T) => boolean,
  account: (dataLength: number) => void
): boolean {
  const gate = slots.insertGate
  if (gate?.pasteGate && !gate.pasteGate.closed && slots.pending.includes(gate)) {
    if (!withinLimits(dataLength)) {
      return false
    }
    slots.pending.splice(slots.pending.indexOf(gate), 0, input)
    account(dataLength)
    return true
  }
  return retain(input)
}

/** Park flush on an open paste marker so connect does not wait for the clipboard. */
export function takePasteGateHead<T extends PasteGatedInput>(
  pending: T[],
  resumeFlush: () => void
): 'parked' | 'skipped' | 'absent' {
  const head = pending[0]
  if (!head?.pasteGate) {
    return 'absent'
  }
  if (!head.pasteGate.closed) {
    // Why: connect must not wait on the clipboard. The paste closes this marker and resumes.
    head.pasteGate.resume = resumeFlush
    return 'parked'
  }
  pending.shift()
  return 'skipped'
}

/**
 * Reserve the next queue slot while this buffer is still holding unbound input.
 * Null when the entry limit is already full.
 */
export function openPasteGateOn<T extends PasteGatedInput>(
  slots: PasteGateSlots<T>,
  withinLimits: (dataLength: number) => boolean,
  createMarker: () => T
): PtyPreconnectPasteHold | null {
  if (!withinLimits(0)) {
    return null
  }
  const input = createMarker()
  input.pasteGate = { closed: false }
  slots.pending.push(input)
  return {
    insertIncoming(run) {
      if (input.pasteGate?.closed) {
        return run()
      }
      const previous = slots.insertGate
      slots.insertGate = input
      try {
        return run()
      } finally {
        slots.insertGate = previous
      }
    },
    close() {
      const gate = input.pasteGate
      if (!gate || gate.closed) {
        return
      }
      gate.closed = true
      const index = slots.pending.indexOf(input)
      if (index !== -1) {
        slots.pending.splice(index, 1)
      }
      if (slots.insertGate === input) {
        slots.insertGate = null
      }
      const resume = gate.resume
      gate.resume = undefined
      resume?.()
    }
  }
}
