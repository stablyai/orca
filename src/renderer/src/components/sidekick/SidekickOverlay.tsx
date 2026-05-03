import { useEffect, useRef, useState } from 'react'
import { useSidekickUrl } from './useSidekickUrl'

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible'
  )
  useEffect(() => {
    const onChange = (): void => {
      setVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

const SIZE = 180
const POSITION_STORAGE_KEY = 'sidekick-overlay-position'

type Position = { x: number; y: number }

function clampToViewport(pos: Position): Position {
  if (typeof window === 'undefined') {
    return pos
  }
  const maxX = Math.max(0, window.innerWidth - SIZE)
  const maxY = Math.max(0, window.innerHeight - SIZE)
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY)
  }
}

function loadStoredPosition(): Position | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<Position>
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
      return null
    }
    return clampToViewport({ x: parsed.x, y: parsed.y })
  } catch {
    return null
  }
}

function defaultPosition(): Position {
  if (typeof window === 'undefined') {
    return { x: 0, y: 0 }
  }
  // Matches previous bottom-4 right-16 (right: 4rem, bottom: 1rem).
  return clampToViewport({
    x: window.innerWidth - SIZE - 64,
    y: window.innerHeight - SIZE - 16
  })
}

export function SidekickOverlay(): React.JSX.Element {
  const documentVisible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  const { url } = useSidekickUrl()

  const [position, setPosition] = useState<Position>(
    () => loadStoredPosition() ?? defaultPosition()
  )
  const [dragging, setDragging] = useState(false)
  const dragOffsetRef = useRef<Position>({ x: 0, y: 0 })

  useEffect(() => {
    const onResize = (): void => setPosition((prev) => clampToViewport(prev))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (dragging) {
      return
    }
    try {
      window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position))
    } catch {
      // ignore storage failures
    }
  }, [dragging, position])

  const animate = documentVisible && !reducedMotion && !dragging

  // Why: setPointerCapture routes subsequent pointer events to this element
  // even when the cursor leaves the OS window, so dragging can't get stuck in
  // the "true" state if the user releases outside the app.
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return
    }
    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    event.preventDefault()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) {
      return
    }
    setPosition(
      clampToViewport({
        x: event.clientX - dragOffsetRef.current.x,
        y: event.clientY - dragOffsetRef.current.y
      })
    )
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
  }

  return (
    // Why: the wrapper is fixed-positioned and pointer-events-none so app
    // chrome stays interactive; only the sidekick itself opts back in to
    // pointer events so the user can press and drag it around.
    <div
      aria-hidden
      className="pointer-events-none fixed z-40"
      style={{
        left: position.x,
        top: position.y,
        width: SIZE,
        height: SIZE
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="pointer-events-auto flex size-full select-none items-center justify-end"
        style={{
          cursor: dragging ? 'grabbing' : 'grab',
          animation: 'sidekick-bob 1.2s ease-in-out infinite',
          animationPlayState: animate ? 'running' : 'paused',
          touchAction: 'none'
        }}
      >
        <style>
          {
            '@keyframes sidekick-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }'
          }
        </style>
        <img src={url} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
      </div>
    </div>
  )
}

export default SidekickOverlay
