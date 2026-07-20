import { useEffect, useMemo, useRef } from 'react'
import type { DetectedSpriteCacheEntry } from './pet-blob-cache'

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

  // Why: reset playback only when the sprite itself changes so a new animation
  // starts from frame 0. The draw effect below also reruns on animate/footprint
  // toggles (pause, resize, drag holds), and those must resume, not snap back.
  useEffect(() => {
    frameIndexRef.current = 0
    lastTimeRef.current = 0
  }, [detected])

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
