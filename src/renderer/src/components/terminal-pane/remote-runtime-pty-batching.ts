export type RemoteRuntimePtyBatcher = {
  push: (data: string) => void
  takePending: () => string
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

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const flush = (): void => {
    const text = takePending()
    if (text) {
      onFlush(text)
    }
  }

  const takePending = (): string => {
    const text = pending
    pending = ''
    clear()
    return text
  }

  return {
    push(data: string): void {
      pending += data
      if (!timer) {
        timer = setTimeout(flush, delayMs)
      }
    },
    takePending,
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
