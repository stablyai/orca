import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { usePetUrl } from './usePetUrl'
import type { CustomPet } from '../../../../shared/pet-types'
import { useAppStore } from '../../store'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import {
  selectPetAnimationName,
  type PetAnimationName,
  type PetDragAnimation
} from './pet-agent-state'
import { usePetPointerInteraction } from './usePetPointerInteraction'
import { buildSpriteAnimationCss } from './sprite-animation-css'
import { petLaneY } from './pet-walk-lane'
import { DetectedSpriteFrame } from './DetectedSpriteFrame'
import { usePetWalkLane } from './usePetWalkLane'
import { usePetFallToLane, PET_LANDING_SQUASH_MS, PET_RISING_MS } from './usePetFallToLane'
import { poseSpriteFrom } from './bundled-pet-pose-sprite'
import { arbitratePetPose } from './pet-pose-arbitration'
import { petBodyMotionStyle, PET_BODY_MOTION_KEYFRAMES_CSS } from './pet-body-motion-css'

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
// Why: the status bar is the pet's floor (h-6 = 24px), so the lane rests the
// box on top of it rather than letting the pet overlap the bar.
const PET_LANE_BOTTOM_INSET = 24
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

export function PetOverlay(): React.JSX.Element {
  const documentVisible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  const { url, sprite, detected, heldUrl, poses } = usePetUrl()
  const size = useAppStore((s) => s.petSize)
  const petWalks = useAppStore((s) => s.petWalks)
  // Why: off, the pet keeps whatever height you left it at — the lane stops
  // owning y and a release neither falls nor snaps.
  const petReturnsToLane = useAppStore((s) => s.petReturnsToLane)

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
  const laneTop =
    typeof window === 'undefined'
      ? position.y
      : petLaneY(window.innerHeight, size, PET_LANE_BOTTOM_INSET)
  const positionRef = useRef(position)
  positionRef.current = position
  const motionAllowed = documentVisible && !reducedMotion
  const fall = usePetFallToLane({
    size,
    laneY: laneTop,
    readPosition: () => positionRef.current,
    onAdvance: useCallback((x: number, y: number) => setPosition({ x, y }), [setPosition])
  })
  const { dragging, dragAnimation, hovering, dragGeneration, handlers } = usePetPointerInteraction(
    position,
    (next) => setPosition(clampToViewport(next, size)),
    // Why: mirrors Shimeji's Thrown — the drop inherits the cursor's velocity, so
    // a flick arcs the pet instead of dropping it straight down. Reduced motion
    // skips the physics entirely and lets the lane sync below seat it.
    (velocity) => {
      if (petReturnsToLane && motionAllowed && positionRef.current.y < laneTop) {
        fall.start(velocity)
      }
    }
  )

  // Why: the lane owns y in state, not just at render — a grab measures its
  // offset against `position`, so a y left over from a persisted value (or from
  // a mount where the window still reported zero height) would teleport the pet
  // the moment you pick it up. Skipped mid-fall so gravity, not this, seats it.
  useEffect(() => {
    if (dragging || fall.busy || !petReturnsToLane) {
      return
    }
    setPosition((current) => (current.y === laneTop ? current : { x: current.x, y: laneTop }))
  }, [dragging, fall.busy, laneTop, petReturnsToLane, setPosition])

  // Why: catching the pet mid-air must kill the drop, not fight it.
  useEffect(() => {
    if (dragging) {
      fall.cancel()
    }
  }, [dragging, fall])

  useEffect(() => {
    const onResize = (): void => setPosition((prev) => clampToViewport(prev, size))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setPosition, size])

  // Why: keyed on `dragging` alone — the walk moves the pet every frame, and
  // persisting each one would hammer localStorage 60x/s. Where the user last
  // dropped the pet is the only position worth remembering.
  useEffect(() => {
    if (dragging) {
      return
    }
    try {
      window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(positionRef.current))
    } catch {
      // ignore storage failures
    }
  }, [dragging])

  // Why: a still/vertical grab freezes on frame 0 (Codex grab-and-hold); a
  // horizontal drag keeps animating so the running rows show. Bob always pauses.
  const spriteAnimate = motionAllowed && (!dragging || dragAnimation !== null)
  const agentAnimation = usePetAnimationName(dragging, dragAnimation, hovering)
  // Why: pacing and the agent-state row disagree — walking with a breathing row
  // reads as gliding, and a waiting pose should park the pet. Arbitrate once, so
  // the row on screen and whether the lane advances can never contradict.
  const { animation: animationName, pacing } = arbitratePetPose(
    agentAnimation,
    petWalks && !dragging && !fall.busy
  )
  // Why: the sheet holds the pose still on its own frames, so it only freezes
  // for reduced motion or while the pet is in hand.
  const poseAnimate = motionAllowed && !dragging
  // Why: half the rendered artwork width — see the supine lift in the motion CSS.
  const supineLiftPx = poses
    ? (poses.frameWidth * Math.min(size / poses.frameWidth, size / poses.frameHeight)) / 2
    : size / 2
  const walkDirection = usePetWalkLane({
    active: pacing && motionAllowed,
    size,
    readX: () => positionRef.current.x,
    onAdvance: useCallback(
      (x: number) => setPosition((current) => ({ x, y: current.y })),
      [setPosition]
    )
  })
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
      {/* Why: items-end rests the pet's feet on the lane floor (a shorter pet
          would otherwise hover mid-box), and justify-center keeps the walk
          symmetric so it reaches both edges by the same margin. */}
      <div className="pointer-events-none flex size-full items-end justify-center">
        <div
          {...handlers}
          className="pointer-events-auto flex h-fit w-fit select-none"
          style={{
            cursor: dragging ? 'grabbing' : 'grab',
            ...petBodyMotionStyle({
              held: dragging,
              landing: fall.landing,
              motionAllowed,
              landingDurationMs: PET_LANDING_SQUASH_MS,
              selfAnimated: poses !== undefined,
              supine: fall.supine,
              rising: fall.rising,
              supineLiftPx,
              risingDurationMs: PET_RISING_MS
            }),
            touchAction: 'none',
            // Why: floor so the wrapper stays grabbable while w-fit/h-fit would
            // otherwise collapse to 0×0 during the image-load window.
            minWidth: 24,
            minHeight: 24
          }}
        >
          <style>{PET_BODY_MOTION_KEYFRAMES_CSS}</style>
          {/* Why: facing lives on its own layer — the bob/sway animations drive
              `transform`, so a flip declared alongside them would be overridden
              for the whole animation. */}
          <div
            data-pet-facing={walkDirection}
            className="flex"
            style={walkDirection === 'left' ? { transform: 'scaleX(-1)' } : undefined}
          >
            {heldUrl && dragging ? (
              // Why: the bundled pets are single animated WebPs with no arms-up
              // frame, so the held pose is its own asset rather than a sprite row.
              <img
                src={heldUrl}
                alt=""
                className="max-h-full max-w-full object-contain"
                style={{ maxWidth: size, maxHeight: size }}
                draggable={false}
              />
            ) : poses ? (
              // Why: the bundled pose sheet is shaped like a `.codex-pet` sheet, so
              // it rides the same CSS stepping rather than a second render path.
              <SpriteFrame
                key={poses.url}
                url={poses.url}
                sprite={poseSpriteFrom(poses)}
                animate={poseAnimate}
                maxSize={size}
                animationName={animationName}
                restartKey={dragGeneration}
              />
            ) : sprite ? (
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
    </div>
  )
}

export default PetOverlay
