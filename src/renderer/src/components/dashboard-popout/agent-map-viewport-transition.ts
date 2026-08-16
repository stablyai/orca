export type AgentMapViewport = {
  center: { x: number; y: number }
  zoom: number
}

type ViewportTransitionOptions = {
  from: AgentMapViewport
  to: AgentMapViewport
  durationMs: number
  onFrame: (viewport: AgentMapViewport) => void
  onComplete?: () => void
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress
}

export function startAgentMapViewportTransition({
  from,
  to,
  durationMs,
  onFrame,
  onComplete
}: ViewportTransitionOptions): () => void {
  let frameId: number | null = null
  let startedAt: number | null = null
  let cancelled = false
  const tick = (now: number): void => {
    if (cancelled) {
      return
    }
    startedAt ??= now
    const progress = Math.min(1, (now - startedAt) / durationMs)
    const eased = 1 - (1 - progress) ** 3
    onFrame({
      center: {
        x: interpolate(from.center.x, to.center.x, eased),
        y: interpolate(from.center.y, to.center.y, eased)
      },
      zoom: interpolate(from.zoom, to.zoom, eased)
    })
    if (progress < 1) {
      frameId = requestAnimationFrame(tick)
    } else {
      frameId = null
      onComplete?.()
    }
  }
  frameId = requestAnimationFrame(tick)
  return () => {
    cancelled = true
    if (frameId !== null) {
      cancelAnimationFrame(frameId)
    }
  }
}
