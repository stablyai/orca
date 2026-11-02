type ImmediateGlobal = typeof globalThis & {
  setImmediate?: (callback: () => void) => unknown
}

const pendingRendererYields = new Map<number, () => void>()
let nextRendererYieldId = 0
let rendererYieldChannel: MessageChannel | null = null

function isVitestEnvironment(): boolean {
  return typeof process !== 'undefined' && process.env?.VITEST === 'true'
}

function getRendererYieldChannel(): MessageChannel {
  if (!rendererYieldChannel) {
    rendererYieldChannel = new globalThis.MessageChannel()
    rendererYieldChannel.port1.onmessage = (event) => {
      const yieldId = event.data
      const resolve = typeof yieldId === 'number' ? pendingRendererYields.get(yieldId) : undefined
      if (!resolve) {
        return
      }
      pendingRendererYields.delete(yieldId)
      resolve()
    }
  }
  return rendererYieldChannel
}

/** @internal */
export function getPendingRendererYieldCountForTesting(): number {
  return pendingRendererYields.size
}

/** Yields to another runnable task without a timer clamp when supported. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    // Vitest fake timers cannot advance MessageChannel tasks.
    if (isVitestEnvironment()) {
      globalThis.setTimeout(resolve, 0)
      return
    }

    const setImmediate = (globalThis as ImmediateGlobal).setImmediate
    if (typeof window === 'undefined' && setImmediate) {
      setImmediate(resolve)
      return
    }

    if (typeof globalThis.MessageChannel === 'function') {
      // Posted tasks avoid Chromium's nested-timer clamp while still yielding to input and paint.
      const yieldId = nextRendererYieldId
      nextRendererYieldId += 1
      pendingRendererYields.set(yieldId, resolve)
      getRendererYieldChannel().port2.postMessage(yieldId)
      return
    }

    globalThis.setTimeout(resolve, 0)
  })
}
