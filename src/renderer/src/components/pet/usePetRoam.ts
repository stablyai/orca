import { useEffect, useRef } from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  isAgentBusyForRoam,
  isRoamPaused,
  tickRoam,
  type Position
} from './pet-roam'

type UsePetRoamArgs = {
  enabled: boolean
  position: Position
  setPosition: (next: Position | ((current: Position) => Position)) => void
  size: number
  dragging: boolean
  entries: readonly AgentStatusEntry[]
  now: () => number
  staleAfterMs: number
}

/**
 * Drive in-window wander with rAF. Pure math lives in pet-roam; this hook only
 * owns the timer and pause signals (drag + busy agent).
 */
export function usePetRoam({
  enabled,
  position,
  setPosition,
  size,
  dragging,
  entries,
  now,
  staleAfterMs
}: UsePetRoamArgs): void {
  const positionRef = useRef(position)
  positionRef.current = position
  const targetRef = useRef<Position | null>(null)
  const draggingRef = useRef(dragging)
  draggingRef.current = dragging
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const sizeRef = useRef(size)
  sizeRef.current = size

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      targetRef.current = null
      return
    }

    let raf = 0
    let lastTs = 0

    const frame = (ts: number): void => {
      const dt = lastTs === 0 ? 16 : Math.min(64, ts - lastTs)
      lastTs = ts
      const agentBusy = isAgentBusyForRoam(entriesRef.current, now(), staleAfterMs)
      const paused = isRoamPaused({ dragging: draggingRef.current, agentBusy })
      // Drop the current stroll on pause so we re-pick after resume (avoids
      // charging at a stale target from under a drag).
      if (paused) {
        targetRef.current = null
      } else {
        const viewport = { width: window.innerWidth, height: window.innerHeight }
        const ticked = tickRoam({
          position: positionRef.current,
          target: targetRef.current,
          size: sizeRef.current,
          viewport,
          dtMs: dt,
          paused: false
        })
        targetRef.current = ticked.target
        if (
          ticked.position.x !== positionRef.current.x ||
          ticked.position.y !== positionRef.current.y
        ) {
          setPosition(ticked.position)
        }
      }
      raf = window.requestAnimationFrame(frame)
    }

    raf = window.requestAnimationFrame(frame)
    return () => {
      window.cancelAnimationFrame(raf)
      targetRef.current = null
    }
  }, [enabled, setPosition, now, staleAfterMs])
}
