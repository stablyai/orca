import { AGENT_CURSOR_GLYPH_PATH } from './agent-cursor-glyph'
import { CURSOR_REST_HEADING_DEG, type CursorPoint } from './agent-cursor-path'

const PRESS_RING_MS = 450
const HIDDEN_SCALE = 0.4
const HIDDEN_BLUR_PX = 5

const round3 = (value: number): number => Math.round(value * 1000) / 1000

// The glyph's tip sits on the element origin; the outline keeps it legible on any page.
const AGENT_CURSOR_SVG = `<svg width="22" height="24" viewBox="0 0 22 24" aria-hidden="true" focusable="false" style="position:absolute;left:-3px;top:-2px;overflow:visible"><path d="${AGENT_CURSOR_GLYPH_PATH}" fill="var(--browser-agent-cursor-fill)" stroke="var(--browser-agent-cursor-outline)" stroke-width="1.5" stroke-linejoin="round"/></svg>`

export function createCursorElement(layer: HTMLElement): {
  cursor: HTMLDivElement
  glyph: HTMLDivElement
} {
  const cursor = document.createElement('div')
  cursor.className = 'browser-agent-cursor'
  cursor.setAttribute('data-testid', 'browser-agent-cursor')
  const glyph = document.createElement('div')
  glyph.className = 'browser-agent-cursor-glyph'
  glyph.innerHTML = AGENT_CURSOR_SVG
  cursor.appendChild(glyph)
  layer.appendChild(cursor)
  return { cursor, glyph }
}

/** A ring that grows out of the tip and fades, once per press. */
export function playPressRing(
  layer: HTMLElement,
  point: CursorPoint,
  reducedMotion: boolean
): void {
  const ring = document.createElement('div')
  ring.className = 'browser-agent-cursor-ring'
  ring.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`
  layer.appendChild(ring)
  const keyframes = reducedMotion
    ? [{ opacity: 0.6 }, { opacity: 0 }]
    : [
        { opacity: 0.6, scale: '0.35' },
        { opacity: 0, scale: '1.6' }
      ]
  const animation = ring.animate(keyframes, {
    duration: PRESS_RING_MS,
    easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)'
  })
  animation.onfinish = () => ring.remove()
  animation.oncancel = () => ring.remove()
}

/** Fades in from a smaller, blurred cursor; squashes across the travel axis; turns to its heading. */
export function writeCursorFrame(
  cursor: HTMLElement,
  frame: {
    point: CursorPoint
    headingDeg: number
    stretch: number
    squash: number
    squashAxisDeg: number
    shown: number
  }
): void {
  const scale = HIDDEN_SCALE + (1 - HIDDEN_SCALE) * frame.shown
  const blur = HIDDEN_BLUR_PX * (1 - frame.shown)
  const parts = [`translate3d(${round3(frame.point.x)}px, ${round3(frame.point.y)}px, 0)`]
  if (Math.abs(frame.squash - 1) > 0.001) {
    parts.push(
      `rotate(${round3(frame.squashAxisDeg)}deg)`,
      `scale(1, ${round3(frame.squash)})`,
      `rotate(${round3(-frame.squashAxisDeg)}deg)`
    )
  }
  // Turn the glyph to point straight up, scale across its heading, then aim it.
  parts.push(
    `rotate(${round3(frame.headingDeg)}deg)`,
    `scale(${round3(frame.stretch * scale)}, ${round3(scale)})`,
    `rotate(${-CURSOR_REST_HEADING_DEG}deg)`
  )
  cursor.style.transform = parts.join(' ')
  cursor.style.opacity = `${round3(frame.shown)}`
  cursor.style.filter = blur > 0.01 ? `blur(${round3(blur)}px)` : ''
}
