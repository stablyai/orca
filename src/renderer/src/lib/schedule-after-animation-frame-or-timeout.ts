export type ScheduledAnimationFrameFallback = {
  cancel: () => void
}

export function scheduleAfterAnimationFrameOrTimeout(
  callback: () => void,
  timeoutMs = 100
): ScheduledAnimationFrameFallback {
  let settled = false
  let frameId: number | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const cancelFrame = (): void => {
    if (frameId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frameId)
    }
    frameId = null
  }

  timeoutId = setTimeout(() => {
    if (settled) {
      return
    }
    settled = true
    timeoutId = null
    cancelFrame()
    callback()
  }, timeoutMs)

  if (typeof requestAnimationFrame === 'function') {
    const nextFrameId = requestAnimationFrame(() => {
      if (settled) {
        return
      }
      settled = true
      frameId = null
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      callback()
    })
    if (!settled) {
      frameId = nextFrameId
    }
  }

  return {
    cancel: () => {
      if (settled) {
        return
      }
      settled = true
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      cancelFrame()
    }
  }
}
