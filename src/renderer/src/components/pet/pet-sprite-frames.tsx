import { useEffect, useId, useMemo, useRef } from 'react'
import type { DetectedSpriteCacheEntry } from './pet-blob-cache'
import type { CustomPet } from '../../../../shared/pet-types'
import type { PetAnimationName } from './pet-agent-state'
import { buildSpriteAnimationCss } from './sprite-animation-css'

type Sprite = NonNullable<CustomPet['sprite']>

// Why: pet bundles ship a sprite sheet — animate by stepping a CSS background
// across the cells of one row. We pick the row from the live pet state
// when the manifest provides that animation, then fall back to the bundle's
// default animation. imageRendering: 'pixelated' keeps edges crisp even when
// scale is fractional (needed when frames exceed maxSize).
export function SpriteFrame({
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
export function DetectedSpriteFrame({
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
