import { useEffect, useId, useRef, useState } from 'react'
import { useSidekickUrl } from './useSidekickUrl'
import type { DetectedSpriteCacheEntry } from './sidekick-blob-cache'
import type { CustomSidekick } from '../../../../shared/types'
import { useAppStore } from '../../store'

type Sprite = NonNullable<CustomSidekick['sprite']>

// Why: pet bundles ship a sprite sheet — animate by stepping a CSS background
// across the cells of one row. We pick which row + how many frames from the
// manifest's defaultAnimation, falling back to the first row if the manifest
// only declared frame size. imageRendering: 'pixelated' keeps edges crisp even
// when scale is fractional (needed when frames exceed maxSize).
function SpriteFrame({
  url,
  sprite,
  animate,
  maxSize
}: {
  url: string
  sprite: Sprite
  animate: boolean
  maxSize: number
}): React.JSX.Element {
  const animKeyframesId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const anim =
    (sprite.defaultAnimation && sprite.animations?.[sprite.defaultAnimation]) ||
    (sprite.animations ? Object.values(sprite.animations)[0] : undefined)
  const row = anim?.row ?? 0
  // Why: clamp to >=1 so an empty/invalid manifest can't produce steps(0),
  // which is rejected as invalid CSS and freezes the animation.
  const frames = Math.max(1, anim?.frames ?? sprite.columns ?? 1)
  // Why: allow fractional downscaling so frames larger than maxSize shrink to
  // fit instead of overflowing the overlay; mirrors DetectedSpriteFrame's math.
  const scale = Math.min(maxSize / sprite.frameWidth, maxSize / sprite.frameHeight)
  const renderedW = sprite.frameWidth * scale
  const renderedH = sprite.frameHeight * scale
  const bgW = sprite.sheetWidth * scale
  const bgH = sprite.sheetHeight * scale
  const startX = 0
  const startY = -(row * sprite.frameHeight * scale)
  const endX = -(frames * sprite.frameWidth * scale)
  const duration = Math.max(0.1, frames / Math.max(0.1, sprite.fps))
  return (
    <>
      <style>{`@keyframes pet-${animKeyframesId} { from { background-position: ${startX}px ${startY}px; } to { background-position: ${endX}px ${startY}px; } }`}</style>
      <div
        style={{
          width: renderedW,
          height: renderedH,
          backgroundImage: `url(${url})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${bgW}px ${bgH}px`,
          backgroundPosition: `${startX}px ${startY}px`,
          imageRendering: 'pixelated',
          animation: `pet-${animKeyframesId} ${duration}s steps(${frames}) infinite`,
          animationPlayState: animate ? 'running' : 'paused'
        }}
      />
    </>
  )
}

// Why: when the manifest doesn't declare frame size, we auto-detect frames
// from the keyed sheet. Render via canvas because the frames may be different
// sizes; we scale each one to fit the overlay box and step through them at a
// fixed fps. requestAnimationFrame is paused when `animate` is false so the
// overlay respects reduced motion / hidden window.
function DetectedSpriteFrame({
  detected,
  animate,
  maxSize
}: {
  detected: DetectedSpriteCacheEntry
  animate: boolean
  maxSize: number
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameIndexRef = useRef(0)
  const lastTimeRef = useRef(0)
  // Why: honor manifest fps captured at import time so bundles play at their
  // intended speed; default to 8 only when the manifest didn't declare one.
  const fps = detected.fps > 0 ? detected.fps : 8

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }
    canvas.width = maxSize
    canvas.height = maxSize
    // Why: reset playback when the underlying sprite changes so the new
    // animation starts from frame 0 rather than wherever the prior one stopped.
    frameIndexRef.current = 0
    lastTimeRef.current = 0
    let raf = 0
    const draw = (): void => {
      const f = detected.frames[frameIndexRef.current % detected.frames.length]
      const bmp = detected.bitmaps[frameIndexRef.current % detected.bitmaps.length]
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const scale = Math.min(maxSize / f.w, maxSize / f.h)
      const w = f.w * scale
      const h = f.h * scale
      ctx.drawImage(bmp, (maxSize - w) / 2, (maxSize - h) / 2, w, h)
    }
    const tick = (now: number): void => {
      const dt = now - lastTimeRef.current
      if (dt >= 1000 / fps) {
        lastTimeRef.current = now
        frameIndexRef.current = (frameIndexRef.current + 1) % detected.frames.length
        draw()
      }
      if (animate) {
        raf = requestAnimationFrame(tick)
      }
    }
    draw()
    if (animate) {
      lastTimeRef.current = performance.now()
      raf = requestAnimationFrame(tick)
    }
    return () => {
      if (raf) {
        cancelAnimationFrame(raf)
      }
    }
  }, [detected, animate, maxSize])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: maxSize, height: maxSize, imageRendering: 'pixelated' }}
    />
  )
}

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

// Why: keep a default for the cached helpers below; the live size now comes
// from the store so the user can resize from the status-bar menu.
const SIZE = 180
const POSITION_STORAGE_KEY = 'sidekick-overlay-position'

type Position = { x: number; y: number }

function clampToViewport(pos: Position, size: number = SIZE): Position {
  if (typeof window === 'undefined') {
    return pos
  }
  const maxX = Math.max(0, window.innerWidth - size)
  const maxY = Math.max(0, window.innerHeight - size)
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY)
  }
}

function loadStoredPosition(size: number = SIZE): Position | null {
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
    // Why: clamp using the live overlay size so a persisted position from a
    // larger overlay doesn't slip off the bottom/right edge after a shrink.
    return clampToViewport({ x: parsed.x, y: parsed.y }, size)
  } catch {
    return null
  }
}

function defaultPosition(size: number = SIZE): Position {
  if (typeof window === 'undefined') {
    return { x: 0, y: 0 }
  }
  // Matches previous bottom-4 right-16 (right: 4rem, bottom: 1rem).
  return clampToViewport(
    {
      x: window.innerWidth - size - 64,
      y: window.innerHeight - size - 16
    },
    size
  )
}

export function SidekickOverlay(): React.JSX.Element {
  const documentVisible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  const { url, sprite, detected } = useSidekickUrl()
  const size = useAppStore((s) => s.sidekickSize)

  const [position, setPosition] = useState<Position>(() => {
    // Why: read the persisted size eagerly via getState so the initial clamp
    // uses the user's last sidekick size — useState's lazy initializer runs
    // before the `size` prop binding settles, and `loadStoredPosition` would
    // otherwise default to SIZE and clip a previously-saved position.
    const currentSize = useAppStore.getState().sidekickSize ?? SIZE
    return loadStoredPosition(currentSize) ?? defaultPosition(currentSize)
  })
  const [dragging, setDragging] = useState(false)
  const dragOffsetRef = useRef<Position>({ x: 0, y: 0 })

  useEffect(() => {
    const onResize = (): void => setPosition((prev) => clampToViewport(prev, size))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [size])

  // Why: when the user shrinks/grows the overlay, re-clamp so the box never
  // overflows the viewport edges (which would otherwise leave it un-draggable).
  useEffect(() => {
    setPosition((prev) => clampToViewport(prev, size))
  }, [size])

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
      clampToViewport(
        {
          x: event.clientX - dragOffsetRef.current.x,
          y: event.clientY - dragOffsetRef.current.y
        },
        size
      )
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
        width: size,
        height: size
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
        {sprite ? (
          <SpriteFrame url={url} sprite={sprite} animate={animate} maxSize={size} />
        ) : detected ? (
          <DetectedSpriteFrame detected={detected} animate={animate} maxSize={size} />
        ) : (
          <img
            src={url}
            alt=""
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        )}
      </div>
    </div>
  )
}

export default SidekickOverlay
