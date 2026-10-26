import { useEffect, useRef, useState } from 'react'
import { Bot, CircleStop } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Point } from './desktop-app-point-mapping'
import { translate } from '@/i18n/i18n'

// Classic arrow pointer (20x26 viewBox, tip at 0,0).
const CURSOR_PATH = 'M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z'

type DesktopAppAgentOverlayProps = {
  controlling: boolean
  stopped: boolean
  // Agent cursor target in pane-box pixels; null until the agent's first pointed action.
  cursor: Point | null
  // Where the cursor enters from before its first move (the pane's center).
  cursorOrigin: Point
  onStop: () => void
  onAllow: () => void
}

/** Border, cursor and stop pill shown while an agent drives the app in this pane. */
export function DesktopAppAgentOverlay({
  controlling,
  stopped,
  cursor,
  cursorOrigin,
  onStop,
  onAllow
}: DesktopAppAgentOverlayProps): React.JSX.Element | null {
  const travel = useAnimatedCursor(controlling ? cursor : null, cursorOrigin)
  if (!controlling && !stopped) {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-desktop-app-agent-overlay>
      {controlling ? (
        <div
          aria-hidden="true"
          className="desktop-app-agent-glow absolute inset-0 animate-pulse motion-reduce:animate-none"
        />
      ) : null}
      {controlling && travel ? (
        <div
          aria-hidden="true"
          data-desktop-app-agent-cursor
          className="absolute top-0 left-0 transition-transform ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
          style={{
            transform: `translate3d(${travel.point.x}px, ${travel.point.y}px, 0)`,
            transitionDuration: `${travel.durationMs}ms`
          }}
        >
          <svg
            width="20"
            height="26"
            viewBox="0 0 20 26"
            className="desktop-app-agent-cursor-glow overflow-visible"
          >
            <path
              d={CURSOR_PATH}
              className="fill-agent-control stroke-agent-control"
              strokeWidth={3}
              strokeLinejoin="round"
            />
            <path d={CURSOR_PATH} className="fill-agent-control-surface" />
          </svg>
        </div>
      ) : null}
      <div className="absolute inset-x-0 bottom-4 flex justify-center px-4">
        <div
          role="status"
          className="desktop-app-agent-pill pointer-events-auto flex items-center gap-2 rounded-xl border border-agent-control-surface-foreground/40 bg-agent-control-surface py-1.5 pr-1.5 pl-3 text-sm text-agent-control-surface-foreground"
        >
          <Bot className="size-4" aria-hidden="true" />
          <span className="whitespace-nowrap">
            {stopped
              ? translate(
                  'auto.components.desktop.app.pane.DesktopAppAgentOverlay.6ae3316ee2',
                  'The agent was stopped for this app'
                )
              : translate(
                  'auto.components.desktop.app.pane.DesktopAppAgentOverlay.db20d7f6de',
                  'An agent is controlling this app'
                )}
          </span>
          <span aria-hidden="true" className="h-6 w-px bg-agent-control-surface-foreground/15" />
          {stopped ? (
            <Button variant="agent-control-pill" size="sm" onClick={onAllow}>
              {translate(
                'auto.components.desktop.app.pane.DesktopAppAgentOverlay.7a502d7891',
                'Allow again'
              )}
            </Button>
          ) : (
            <Button variant="agent-control-pill" size="sm" onClick={onStop}>
              <CircleStop className="size-4" aria-hidden="true" />
              {translate(
                'auto.components.desktop.app.pane.DesktopAppAgentOverlay.371b67dea5',
                'Stop agent'
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

type CursorTravel = { point: Point; durationMs: number }

// Why: the cursor glides to each point so the user can follow it; a fixed 180ms
// reads as a jump across a wide pane, so the duration grows with the distance.
function useAnimatedCursor(target: Point | null, origin: Point): CursorTravel | null {
  const [travel, setTravel] = useState<CursorTravel | null>(null)
  const lastPoint = useRef<Point | null>(null)
  const targetX = target?.x
  const targetY = target?.y
  useEffect(() => {
    if (targetX === undefined || targetY === undefined) {
      lastPoint.current = null
      setTravel(null)
      return
    }
    const from = lastPoint.current ?? origin
    const to = { x: targetX, y: targetY }
    const durationMs = Math.round(
      Math.min(600, Math.max(180, Math.hypot(to.x - from.x, to.y - from.y) * 0.6))
    )
    const isFirstMove = lastPoint.current === null
    lastPoint.current = to
    if (!isFirstMove) {
      setTravel({ point: to, durationMs })
      return
    }
    // First point: paint at the origin, then move on the next frame so the glide is visible.
    setTravel({ point: from, durationMs })
    const frame = requestAnimationFrame(() => setTravel({ point: to, durationMs }))
    return () => cancelAnimationFrame(frame)
    // origin only seeds the first move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetX, targetY])
  return travel
}
