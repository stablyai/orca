import { useCallback, useEffect, useRef } from 'react'
import {
  startAgentMapViewportTransition,
  type AgentMapViewport
} from './agent-map-viewport-transition'

type AgentMapViewportTransitionOptions = {
  durationMs: number
  reducedMotion: boolean
  onFrame: (viewport: AgentMapViewport) => void
}

export function useAgentMapViewportTransition({
  durationMs,
  reducedMotion,
  onFrame
}: AgentMapViewportTransitionOptions): {
  animate: (from: AgentMapViewport, to: AgentMapViewport) => void
  stop: () => void
} {
  const cancelRef = useRef<(() => void) | null>(null)
  const stop = useCallback((): void => {
    cancelRef.current?.()
    cancelRef.current = null
  }, [])
  const animate = useCallback(
    (from: AgentMapViewport, to: AgentMapViewport): void => {
      stop()
      if (reducedMotion) {
        onFrame(to)
        return
      }
      let cancel = (): void => {}
      cancel = startAgentMapViewportTransition({
        from,
        to,
        durationMs,
        onFrame,
        onComplete: () => {
          if (cancelRef.current === cancel) {
            cancelRef.current = null
          }
        }
      })
      cancelRef.current = cancel
    },
    [durationMs, onFrame, reducedMotion, stop]
  )
  useEffect(() => stop, [stop])
  return { animate, stop }
}
