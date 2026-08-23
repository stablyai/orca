import { useEffect, useId, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { buildSpriteAnimationCss } from './sprite-animation-css'
import { SHEET_COLUMNS } from './pet-sheet-composer'

/** Rows worth showing off in a preview, in the order they cycle.
 *
 *  `loop` mirrors what the overlay does with the row: getting up is one-shot
 *  there, and looping it here would show the pet standing up over and over. */
const TOUR: readonly { row: number; holdMs: number; loop: boolean }[] = [
  { row: 0, holdMs: 1700, loop: true },
  { row: 1, holdMs: 1500, loop: true },
  { row: 3, holdMs: 900, loop: true },
  { row: 4, holdMs: 700, loop: true },
  { row: 5, holdMs: 700, loop: true },
  { row: 6, holdMs: 1300, loop: false }
]

type PetSheetPreviewProps = {
  sheetUrl: string
  frame: { width: number; height: number }
  rows: number
  /** Longest edge of the preview box, in px. */
  size: number
}

/** Plays a generated sheet so the user sees the pet move before saving it.
 *
 *  It tours the rows rather than showing one, because the failures worth
 *  catching before saving — a bad cutout, a subject that reads as a blob — are
 *  most obvious once the thing starts moving. */
export function PetSheetPreview({
  sheetUrl,
  frame,
  rows,
  size
}: PetSheetPreviewProps): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const [step, setStep] = useState(0)
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const timer = setTimeout(() => setStep((n) => (n + 1) % TOUR.length), TOUR[step].holdMs)
    return () => clearTimeout(timer)
  }, [step, reducedMotion])

  // Why: a still preview under reduced motion shows the idle pose rather than
  // freezing mid-tumble on whichever row the tour happened to reach.
  const { row, loop } = reducedMotion ? TOUR[0] : TOUR[step]
  const scale = Math.min(size / frame.width, size / frame.height)
  const rowOffsetY = -(row * frame.height * scale)
  const { keyframesCss, animationCss } = buildSpriteAnimationCss({
    keyframesId: `${baseId}-preview-${row}`,
    frames: SHEET_COLUMNS,
    fps: 8,
    frameWidth: frame.width,
    scale,
    rowOffsetY,
    frameDurationsMs: undefined,
    loop
  })

  return (
    <>
      <style>{keyframesCss}</style>
      <div
        data-preview-row={row}
        style={{
          width: frame.width * scale,
          height: frame.height * scale,
          backgroundImage: `url(${sheetUrl})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${frame.width * SHEET_COLUMNS * scale}px ${frame.height * rows * scale}px`,
          backgroundPosition: `0px ${rowOffsetY}px`,
          imageRendering: 'pixelated',
          animation: animationCss,
          animationPlayState: reducedMotion ? 'paused' : 'running'
        }}
      />
    </>
  )
}
