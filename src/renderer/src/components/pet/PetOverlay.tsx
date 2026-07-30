import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { usePetUrl } from './usePetUrl'
import type { DetectedSpriteCacheEntry } from './pet-blob-cache'
import type { CustomPet } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import {
  selectPetAnimationName,
  type PetAnimationName,
  type PetDragAnimation
} from './pet-agent-state'
import { usePetPointerInteraction } from './usePetPointerInteraction'
import { buildSpriteAnimationCss } from './sprite-animation-css'

type Sprite = NonNullable<CustomPet['sprite']>

function usePetAnimationName(
  dragging: boolean,
  dragAnimation: PetDragAnimation,
  hovering: boolean
): PetAnimationName {
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)

  // Re-render when the freshness scheduler ticks so stale live states stop
  // driving pet animations even if no other store value changes.
  void agentStatusEpoch

  return selectPetAnimationName({
    entries: Object.values(agentStatusByPaneKey),
    retainedCount: Object.keys(retainedAgentsByPaneKey).length,
    dragging,
    dragAnimation,
    hovering,
    now: Date.now(),
    staleAfterMs: AGENT_STATUS_STALE_AFTER_MS
  })
}

// Why: pet bundles ship a sprite sheet — animate by stepping a CSS background
// across the cells of one row. We pick the row from the live pet state
// when the manifest provides that animation, then fall back to the bundle's
// default animation. imageRendering: 'pixelated' keeps edges crisp even when
// scale is fractional (needed when frames exceed maxSize).
function SpriteFrame({
  url,
  sprite,
  animate,
  maxSize,
  animationName,
  restartKey
}: {
  url: string
  sprite: Sprite
  animate: boolean
  maxSize: number
  animationName: PetAnimationName
  // Why: folded into the keyframes name, so bumping it mints a fresh animation
  // that restarts from frame 0 even when the state row is unchanged.
  restartKey: number
}): React.JSX.Element {
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const anim =
    sprite.animations?.[animationName] ||
    (sprite.defaultAnimation && sprite.animations?.[sprite.defaultAnimation]) ||
    (sprite.animations ? Object.values(sprite.animations)[0] : undefined)
  const row = anim?.row ?? 0
  // Why: clamp to >=1 so an empty/invalid manifest can't produce steps(0),
  // which is rejected as invalid CSS and freezes the animation.
  const frames = Math.max(1, anim?.frames ?? sprite.columns ?? 1)
  // Why: name the @keyframes by the RESOLVED track (+restartKey for same-row
  // grabs), so a genuine row change starts at frame 0 while a state that falls
  // back to the same row (e.g. hover on a pet without a jumping row) doesn't
  // needlessly restart.
  const animKeyframesId = `${baseId}-${row}-${frames}-${restartKey}`
  // Why: allow fractional downscaling so frames larger than maxSize shrink to
  // fit instead of overflowing the overlay; mirrors DetectedSpriteFrame's math.
  const scale = Math.min(maxSize / sprite.frameWidth, maxSize / sprite.frameHeight)
  const renderedW = sprite.frameWidth * scale
  const renderedH = sprite.frameHeight * scale
  const bgW = sprite.sheetWidth * scale
  const bgH = sprite.sheetHeight * scale
  const startX = 0
  const startY = -(row * sprite.frameHeight * scale)
  const { keyframesCss, animationCss } = buildSpriteAnimationCss({
    keyframesId: animKeyframesId,
    frames,
    fps: sprite.fps,
    frameWidth: sprite.frameWidth,
    scale,
    rowOffsetY: startY,
    frameDurationsMs: anim?.frameDurationsMs
  })
  return (
    <>
      <style>{keyframesCss}</style>
      <div
        style={{
          width: renderedW,
          height: renderedH,
          backgroundImage: `url(${url})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${bgW}px ${bgH}px`,
          backgroundPosition: `${startX}px ${startY}px`,
          imageRendering: 'pixelated',
          animation: animationCss,
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

  // Why: size the canvas to one fixed footprint bounding the largest scaled
  // frame so the drag wrapper hugs the pet instead of a maxSize square. A
  // single size across frames avoids the jitter a per-frame resize would cause.
  const { footprintW, footprintH } = useMemo(() => {
    let w = 0
    let h = 0
    for (const f of detected.frames) {
      const s = Math.min(maxSize / f.w, maxSize / f.h)
      w = Math.max(w, f.w * s)
      h = Math.max(h, f.h * s)
    }
    return { footprintW: Math.max(1, Math.round(w)), footprintH: Math.max(1, Math.round(h)) }
  }, [detected, maxSize])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }
    canvas.width = footprintW
    canvas.height = footprintH
    // Why: reset playback when the underlying sprite changes so the new
    // animation starts from frame 0 rather than wherever the prior one stopped.
    frameIndexRef.current = 0
    lastTimeRef.current = 0
    if (detected.frames.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    let raf = 0
    const draw = (): void => {
      const f = detected.frames[frameIndexRef.current % detected.frames.length]
      const bmp = detected.bitmaps[frameIndexRef.current % detected.bitmaps.length]
      if (!f || !bmp) {
        return
      }
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const scale = Math.min(maxSize / f.w, maxSize / f.h)
      const w = f.w * scale
      const h = f.h * scale
      // Why: center each frame within the fixed footprint so frames of differing
      // sizes stay aligned without resizing the canvas per frame.
      ctx.drawImage(bmp, (footprintW - w) / 2, (footprintH - h) / 2, w, h)
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
  }, [detected, animate, footprintW, footprintH, maxSize, fps])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: footprintW, height: footprintH, imageRendering: 'pixelated' }}
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

// Why: keep a default for the cached helpers below; the live size now comes
// from the store so the user can resize from the status-bar menu.
const SIZE = 180
const POSITION_STORAGE_KEY = 'pet-overlay-position'
const LEGACY_POSITION_STORAGE_KEY = 'sidekick-overlay-position'

export type Position = { x: number; y: number }

export function clampPositionToViewport(
  pos: Position,
  size: number,
  viewport: { width: number; height: number }
): Position {
  const maxX = Math.max(0, viewport.width - size)
  const maxY = Math.max(0, viewport.height - size)
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY)
  }
}

function clampToViewport(pos: Position, size: number = SIZE): Position {
  if (typeof window === 'undefined') {
    return pos
  }
  return clampPositionToViewport(pos, size, {
    width: window.innerWidth,
    height: window.innerHeight
  })
}

function loadStoredPosition(size: number = SIZE): Position | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    let raw = window.localStorage.getItem(POSITION_STORAGE_KEY)
    let migratedFromLegacy = false
    if (!raw) {
      raw = window.localStorage.getItem(LEGACY_POSITION_STORAGE_KEY)
      if (!raw) {
        return null
      }
      migratedFromLegacy = true
    }
    const parsed = JSON.parse(raw) as Partial<Position>
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
      return null
    }
    if (migratedFromLegacy) {
      try {
        window.localStorage.setItem(POSITION_STORAGE_KEY, raw)
      } catch {
        // ignore storage failures
      }
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

// Why: the bob float is runtime CSS, not user-visible copy; keep CSS keywords
// out of i18n so translated locales cannot invalidate the keyframes.
const PET_BOB_KEYFRAMES_CSS =
  '@keyframes pet-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }'
export function PetOverlay(): React.JSX.Element {
  const documentVisible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  const { url, sprite, detected } = usePetUrl()
  const size = useAppStore((s) => s.petSize)

  const [positionState, setPositionState] = useState<{
    size: number
    position: Position
  }>(() => {
    // Why: read the persisted size eagerly via getState so the initial clamp
    // uses the user's last pet size — useState's lazy initializer runs
    // before the `size` prop binding settles, and `loadStoredPosition` would
    // otherwise default to SIZE and clip a previously-saved position.
    const currentSize = useAppStore.getState().petSize ?? SIZE
    return {
      size: currentSize,
      position: loadStoredPosition(currentSize) ?? defaultPosition(currentSize)
    }
  })
  let position = positionState.position
  if (positionState.size !== size) {
    position = clampToViewport(positionState.position, size)
    setPositionState({ size, position })
  }
  const setPosition = useCallback(
    (nextPosition: Position | ((current: Position) => Position)): void => {
      setPositionState((current) => {
        const currentPosition =
          current.size === size ? current.position : clampToViewport(current.position, size)
        return {
          size,
          position:
            typeof nextPosition === 'function' ? nextPosition(currentPosition) : nextPosition
        }
      })
    },
    [size]
  )
  const { dragging, dragAnimation, hovering, dragGeneration, handlers } = usePetPointerInteraction(
    position,
    (next) => setPosition(clampToViewport(next, size))
  )

  useEffect(() => {
    const onResize = (): void => setPosition((prev) => clampToViewport(prev, size))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setPosition, size])

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

  const motionAllowed = documentVisible && !reducedMotion
  // Why: a still/vertical grab freezes on frame 0 (Codex grab-and-hold); a
  // horizontal drag keeps animating so the running rows show. Bob always pauses.
  const spriteAnimate = motionAllowed && (!dragging || dragAnimation !== null)
  const bobAnimate = motionAllowed && !dragging
  const animationName = usePetAnimationName(dragging, dragAnimation, hovering)

  return (
    // Why: the outer box and middle layer stay pointer-events-none so app chrome
    // stays interactive; only the innermost wrapper opts in and shrink-wraps its
    // content, so the grab/drag hit area hugs the pet, not the full square box.
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
      <div className="pointer-events-none flex size-full items-center justify-end">
        <div
          {...handlers}
          className="pointer-events-auto flex h-fit w-fit select-none"
          style={{
            cursor: dragging ? 'grabbing' : 'grab',
            animation: 'pet-bob 1.2s ease-in-out infinite',
            animationPlayState: bobAnimate ? 'running' : 'paused',
            touchAction: 'none',
            // Why: floor so the wrapper stays grabbable while w-fit/h-fit would
            // otherwise collapse to 0×0 during the image-load window.
            minWidth: 24,
            minHeight: 24
          }}
        >
          <style>{PET_BOB_KEYFRAMES_CSS}</style>
          {sprite ? (
            // Why: remount per pet so a switched-to sprite starts a fresh
            // animation instead of inheriting the prior pet's currentTime.
            <SpriteFrame
              key={url}
              url={url}
              sprite={sprite}
              animate={spriteAnimate}
              maxSize={size}
              animationName={animationName}
              restartKey={dragGeneration}
            />
          ) : detected ? (
            <DetectedSpriteFrame detected={detected} animate={spriteAnimate} maxSize={size} />
          ) : (
            // Why: cap explicitly at the pet size — the w-fit/h-fit wrapper is
            // fit-content, so max-w/h-full has no fixed box to resolve against
            // and the image would otherwise render at its intrinsic size and
            // overflow the persisted size box that clamping still assumes.
            <img
              src={url}
              alt=""
              className="max-h-full max-w-full object-contain"
              style={{ maxWidth: size, maxHeight: size }}
              draggable={false}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default PetOverlay
