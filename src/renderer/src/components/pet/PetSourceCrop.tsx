import { useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { rectFromDrag, type Point, type Size } from './pet-crop-drag'
import { clampCropRect, type CropRect } from './pet-image-crop'

type PetSourceCropProps = {
  sourceUrl: string
  image: Size
  crop: CropRect | null
  onCrop: (rect: CropRect) => void
  /** Longest edge of the surface, in CSS pixels. */
  box: number
  /** Id of the copy that teaches the gestures, in the surrounding form. */
  describedBy?: string
}

/** Fits the picture inside the box without distorting it. */
function fit(image: Size, box: number): Size {
  const longest = Math.max(image.width, image.height, 1)
  const scale = box / longest
  return { width: Math.max(1, image.width * scale), height: Math.max(1, image.height * scale) }
}

/** Where the keyboard starts from when nothing has been framed yet. */
function centeredFrame(image: Size): CropRect {
  const width = Math.max(1, Math.round(image.width * 0.6))
  const height = Math.max(1, Math.round(image.height * 0.6))
  return {
    x: Math.round((image.width - width) / 2),
    y: Math.round((image.height - height) / 2),
    width,
    height
  }
}

const ARROWS: Record<string, Point | undefined> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 }
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
  box,
  describedBy
}: PetSourceCropProps): React.JSX.Element {
  const surface = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null)
  const [keyed, setKeyed] = useState<CropRect | null>(null)
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

  // Why: a gesture the OS takes away (a system menu, a touch that becomes a
  // scroll) never sends pointerup, so the rectangle would stay stuck mid-drag.
  const onPointerCancel = (): void => {
    setDrag(null)
  }

  // Why: keydown moves the frame but does not commit it, so an autorepeating
  // arrow is one framing and one rebuild — the same bargain the drag makes by
  // committing on pointerup rather than on every sample.
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const direction = ARROWS[event.key]
    if (!direction) {
      return
    }
    event.preventDefault()
    const step = Math.max(1, Math.round(Math.max(image.width, image.height) / 20))
    const base = keyed ?? crop ?? centeredFrame(image)
    const next = event.shiftKey
      ? {
          ...base,
          width: base.width + direction.x * step,
          height: base.height + direction.y * step
        }
      : { ...base, x: base.x + direction.x * step, y: base.y + direction.y * step }
    setKeyed(clampCropRect(next, image.width, image.height))
  }

  const onKeyUp = (): void => {
    if (!keyed) {
      return
    }
    setKeyed(null)
    onCrop(keyed)
  }

  // Why: while dragging, show the live rectangle rather than the committed one —
  // otherwise the box only appears after the gesture it is describing has ended.
  const shown = drag ? rectFromDrag(drag.from, drag.to, display, image) : (keyed ?? crop)
  const scaleX = display.width / Math.max(1, image.width)
  const scaleY = display.height / Math.max(1, image.height)

  return (
    // Why: `application` rather than a plain group — the arrows are the whole
    // interaction here, and a screen reader's browse cursor would eat them.
    <div
      ref={surface}
      data-crop-surface
      role="application"
      tabIndex={0}
      aria-label={translate(
        'auto.components.pet.sourceCrop.surface',
        'Framing: draw the box the pet is built from'
      )}
      aria-describedby={describedBy}
      className="relative cursor-crosshair touch-none overflow-hidden rounded-md border border-border bg-accent/5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ width: display.width, height: display.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <img src={sourceUrl} alt="" className="pointer-events-none size-full object-fill" />
      {shown ? (
        <div
          data-crop-frame
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
