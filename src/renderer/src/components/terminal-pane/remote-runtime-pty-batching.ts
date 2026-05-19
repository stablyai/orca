export type RemoteRuntimePtyBatcher = {
  push: (data: string) => void
  flush: () => void
  clear: () => void
}

export type RemoteRuntimeViewportBatcher = {
  queue: (cols: number, rows: number) => void
  flush: () => void
  clear: () => void
}

export function createRemoteRuntimePtyTextBatcher(
  delayMs: number,
  onFlush: (text: string) => void
): RemoteRuntimePtyBatcher {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let microtaskScheduled = false
  let scheduleGeneration = 0

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    microtaskScheduled = false
    scheduleGeneration++
  }

  const flush = (): void => {
    const text = pending
    pending = ''
    clear()
    if (text) {
      onFlush(text)
    }
  }

  const scheduleFlush = (): void => {
    if (timer || microtaskScheduled) {
      return
    }
    if (delayMs <= 0) {
      microtaskScheduled = true
      const generation = scheduleGeneration
      // Why: remote typing should not pay a fixed timer delay, but same-turn
      // xterm bursts still need one coalescing point before crossing RPC.
      queueMicrotask(() => {
        if (microtaskScheduled && generation === scheduleGeneration) {
          flush()
        }
      })
      return
    }
    timer = setTimeout(flush, delayMs)
  }

  return {
    push(data: string): void {
      pending += data
      scheduleFlush()
    },
    flush,
    clear
  }
}

export function createRemoteRuntimeViewportBatcher(
  delayMs: number,
  onFlush: (cols: number, rows: number) => void
): RemoteRuntimeViewportBatcher {
  let pending: { cols: number; rows: number } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const flush = (): void => {
    const viewport = pending
    pending = null
    clear()
    if (viewport) {
      onFlush(viewport.cols, viewport.rows)
    }
  }

  return {
    queue(cols: number, rows: number): void {
      pending = { cols, rows }
      if (!timer) {
        timer = setTimeout(flush, delayMs)
      }
    },
    flush,
    clear
  }
}
