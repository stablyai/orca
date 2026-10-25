import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { usePetUrl } from './usePetUrl'
import type { DetectedSpriteCacheEntry } from './pet-blob-cache'
import type { CustomPet } from '../../../../shared/pet-types'
import { useAppStore } from '../../store'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
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
  // Scheduler ticks expire animation evidence even without other store updates; read the boundary clock before paint.
  const agentStatusNow = getAgentStatusEpochNow(agentStatusEpoch)

  return selectPetAnimationName({
    entries: Object.values(agentStatusByPaneKey),
    retainedCount: Object.keys(retainedAgentsByPaneKey).length,
    dragging,
    dragAnimation,
    hovering,
    now: agentStatusNow,
    staleAfterMs: AGENT_STATUS_STALE_AFTER_MS
  })
}

// Step backgrounds across the resolved sprite row; pixelated rendering keeps fractional-scale edges crisp.
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
  // Include in keyframes identity to restart same-row grabs at frame 0.
  restartKey: number
}): React.JSX.Element {
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const anim =
    sprite.animations?.[animationName] ||
    (sprite.defaultAnimation && sprite.animations?.[sprite.defaultAnimation]) ||
    (sprite.animations ? Object.values(sprite.animations)[0] : undefined)
  const row = anim?.row ?? 0
  // steps(0) is invalid CSS; tolerate empty/invalid manifests with at least one frame.
  const frames = Math.max(1, anim?.frames ?? sprite.columns ?? 1)
  // Key by resolved track/grab generation so actual changes restart, but same-row fallbacks do not.
  const animKeyframesId = `${baseId}-${row}-${frames}-${restartKey}`
  // Allow fractional scaling so oversized frames fit the overlay.
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

// Without manifest dimensions, draw detected irregular frames on canvas and pause rAF for hidden/reduced-motion views.
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
  const fps = detected.fps > 0 ? detected.fps : 8

  // Use one footprint for the largest scaled frame so the hit area hugs the pet without per-frame jitter.
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

// Fallback for cached position callers; live sizing comes from the store.
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
      } catch {}
    }
    // Clamp retained positions against the current size to keep the pet within viewport bounds.
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

// Keep runtime CSS keywords outside translation so locales cannot invalidate animation.
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
    // Read persisted size before initial clamping; the fallback size could clip a restored position.
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
    } catch {}
  }, [dragging, position])

  const motionAllowed = documentVisible && !reducedMotion
  // Stationary/vertical grabs pause at frame 0; horizontal drags animate running rows, while bob always pauses.
  const spriteAnimate = motionAllowed && (!dragging || dragAnimation !== null)
  const bobAnimate = motionAllowed && !dragging
  const animationName = usePetAnimationName(dragging, dragAnimation, hovering)

  return (
    // Only the content-fit wrapper takes pointer events so empty overlay space cannot block app chrome.
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
            // Keep a minimum grab area while loading would otherwise collapse fit-content dimensions.
            minWidth: 24,
            minHeight: 24
          }}
        >
          <style>{PET_BOB_KEYFRAMES_CSS}</style>
          {sprite ? (
            // Remount per URL so pet changes cannot inherit the prior animation’s currentTime.
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
            // Fit-content parents give max-full no fixed size; cap the image explicitly to preserve clamping bounds.
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
