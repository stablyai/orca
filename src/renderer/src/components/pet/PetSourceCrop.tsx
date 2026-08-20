import { useRef, useState } from 'react'
import { rectFromDrag, type Point, type Size } from './pet-crop-drag'
import type { CropRect } from './pet-image-crop'

type PetSourceCropProps = {
  sourceUrl: string
  image: Size
  crop: CropRect | null
  onCrop: (rect: CropRect) => void
  /** Longest edge of the surface, in CSS pixels. */
  box: number
}

/** Fits the picture inside the box without distorting it. */
function fit(image: Size, box: number): Size {
  const longest = Math.max(image.width, image.height, 1)
  const scale = box / longest
  return { width: Math.max(1, image.width * scale), height: Math.max(1, image.height * scale) }
}

/** Lets the user draw the box the pet is built from.
 *
 *  Framing is the one piece of information the pipeline cannot derive: which of
 *  the things in the picture is the character. A drag says it in one gesture. */
export function PetSourceCrop({
  sourceUrl,
  image,
  crop,
  onCrop,
  box
}: PetSourceCropProps): React.JSX.Element {
  const surface = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null)
  const display = fit(image, box)

  const pointAt = (event: React.PointerEvent): Point => {
    const rect = surface.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const onPointerDown = (event: React.PointerEvent): void => {
    const at = pointAt(event)
    setDrag({ from: at, to: at })
    surface.current?.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent): void => {
    setDrag((current) => (current ? { from: current.from, to: pointAt(event) } : null))
  }

  const onPointerUp = (event: React.PointerEvent): void => {
    if (!drag) {
      return
    }
    const to = pointAt(event)
    setDrag(null)
    surface.current?.releasePointerCapture?.(event.pointerId)
    onCrop(rectFromDrag(drag.from, to, display, image))
  }

  // Why: while dragging, show the live rectangle rather than the committed one —
  // otherwise the box only appears after the gesture it is describing has ended.
  const shown = drag ? rectFromDrag(drag.from, drag.to, display, image) : crop
  const scaleX = display.width / Math.max(1, image.width)
  const scaleY = display.height / Math.max(1, image.height)

  return (
    <div
      ref={surface}
      data-crop-surface
      className="relative cursor-crosshair touch-none overflow-hidden rounded-md border border-border bg-accent/5"
      style={{ width: display.width, height: display.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <img src={sourceUrl} alt="" className="pointer-events-none size-full object-fill" />
      {shown ? (
        <div
          className="pointer-events-none absolute border-2 border-primary bg-primary/10"
          style={{
            left: shown.x * scaleX,
            top: shown.y * scaleY,
            width: shown.width * scaleX,
            height: shown.height * scaleY
          }}
        />
      ) : null}
    </div>
  )
}
