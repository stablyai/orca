const transactionTails = new Map<string, Promise<void>>()

export async function runTerminalPtyInputTransaction<T>(
  ptyId: string | null | undefined,
  operation: () => Promise<T>
): Promise<T> {
  if (!ptyId) {
    return await operation()
  }

  const previous = transactionTails.get(ptyId)
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  transactionTails.set(ptyId, current)

  if (previous) {
    await previous
  }
  try {
    return await operation()
  } finally {
    release()
    if (transactionTails.get(ptyId) === current) {
      transactionTails.delete(ptyId)
    }
  }
}

/** A turn in the same transaction order, held until released. Aborting while queued gives the turn
 *  up at once without running anything; later turns still wait for the ones before it. */
export function acquireTerminalPtyInputTurn(
  ptyId: string,
  signal: AbortSignal
): Promise<() => void> {
  const previous = transactionTails.get(ptyId) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => turn)
  transactionTails.set(ptyId, tail)
  void tail.then(() => {
    if (transactionTails.get(ptyId) === tail) {
      transactionTails.delete(ptyId)
    }
  })
  return new Promise((resolve, reject) => {
    const giveUp = (): void => {
      release()
      reject(new Error('request_aborted'))
    }
    if (signal.aborted) {
      return giveUp()
    }
    signal.addEventListener('abort', giveUp, { once: true })
    void previous.then(() => {
      if (!signal.aborted) {
        signal.removeEventListener('abort', giveUp)
        resolve(release)
      }
    })
  })
}
