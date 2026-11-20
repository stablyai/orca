import { useLayoutEffect, useRef, type JSX, type RefObject } from 'react'

/**
 * The pointer that clicks through page 2: `cue` names a target (with `-press` while it presses) or
 * `hide`. It glides to the target's centre as the camera moves; hidden, it measures nothing.
 */
export function BotsTipPointer({
  cue,
  targets
}: {
  cue: string
  targets: Record<string, RefObject<HTMLElement | null>>
}): JSX.Element {
  const pointer = useRef<SVGSVGElement>(null)
  const [name, press] = cue.split('-')
  const shown = Boolean(name) && name !== 'hide'
  // Hidden: fade out and rest low in the window, where the next glide starts; once per cue.
  useLayoutEffect(() => {
    const node = pointer.current
    const win = node?.parentElement
    if (shown || !node || !win) {
      return
    }
    node.style.opacity = '0'
    node.style.transform = `translate(${win.clientWidth * 0.62}px, ${win.clientHeight * 0.92}px)`
  }, [shown])
  // Shown: follow the target's centre every frame, as the camera moves under it.
  useLayoutEffect(() => {
    const node = pointer.current
    const win = node?.parentElement
    const target = shown && name ? targets[name]?.current : null
    if (!node || !win || !target) {
      return
    }
    node.style.opacity = '1'
    const box = target.getBoundingClientRect()
    const frame = win.getBoundingClientRect()
    // The window is scaled by the camera; place the pointer in its own coordinates.
    const scale = frame.width / win.offsetWidth
    const x = (box.left - frame.left + box.width * 0.45) / scale
    const y = (box.top - frame.top + box.height * 0.55) / scale
    node.style.transform = `translate(${x}px, ${y}px)${press ? ' scale(.82)' : ''}`
  })
  return (
    <svg ref={pointer} className="bt-pointer" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 2l16 9.5-7 1.5-3.5 6.5z" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}
