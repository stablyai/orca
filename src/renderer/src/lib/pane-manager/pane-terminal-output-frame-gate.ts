export const TERMINAL_OUTPUT_FRAME_FALLBACK_MS = 32

export type PaneTerminalOutputFrameGate = {
  schedule: () => void
  cancel: () => void
  isPending: () => boolean
}

export function createPaneTerminalOutputFrameGate(
  onFrame: () => void
): PaneTerminalOutputFrameGate {
  let frameId: number | null = null
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0

  const cancelHandles = (): void => {
    if (frameId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(frameId)
    }
    frameId = null
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }

  const release = (expectedGeneration: number): void => {
    if (expectedGeneration !== generation || (frameId === null && fallbackTimer === null)) {
      return
    }
    cancelHandles()
    onFrame()
  }

  return {
    schedule: () => {
      if (frameId !== null || fallbackTimer !== null) {
        return
      }
      generation += 1
      const scheduledGeneration = generation
      fallbackTimer = setTimeout(
        () => release(scheduledGeneration),
        TERMINAL_OUTPUT_FRAME_FALLBACK_MS
      )
      if (typeof globalThis.requestAnimationFrame === 'function') {
        const requestedFrameId = globalThis.requestAnimationFrame(() =>
          release(scheduledGeneration)
        )
        // Test and embedded runtimes may invoke the callback synchronously.
        // Do not resurrect an already-released frame with its returned id.
        if (fallbackTimer !== null) {
          frameId = requestedFrameId
        }
      }
      // Why: Electron can suppress rAF after stale visibility state; one timer
      // bounds ACK and output latency without creating a recurring wakeup loop.
    },
    cancel: () => {
      generation += 1
      cancelHandles()
    },
    isPending: () => frameId !== null || fallbackTimer !== null
  }
}
