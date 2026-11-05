export type TerminalReplayFrameCapture =
  | { kind: 'retained'; frame: HTMLElement }
  // Nothing painted to keep (hidden or never-rendered screen): withholding it shows no less.
  | { kind: 'empty' }
  // Pixels exist but cannot be copied; withholding the screen would flash it blank.
  | { kind: 'unavailable' }

// A transaction-local image, never a cached terminal buffer or an input target.
export function retainTerminalReplayFrame(
  screen: HTMLElement,
  repaintForCapture: () => boolean
): TerminalReplayFrameCapture {
  const initialBounds = screen.getBoundingClientRect()
  if (initialBounds.width <= 0 || initialBounds.height <= 0 || !screen.childElementCount) {
    return { kind: 'empty' }
  }
  try {
    // WebGL discards its drawing buffer after compositing, so copy in the task that repaints it.
    if (screen.querySelector('canvas') && !repaintForCapture()) {
      return { kind: 'unavailable' }
    }
    // Releasing xterm's render pause can flush a resize or replace its renderer.
    const bounds = screen.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) {
      return { kind: 'empty' }
    }
    const frame = document.createElement('div')
    frame.dataset.terminalReplayFrame = 'true'
    frame.setAttribute('aria-hidden', 'true')
    frame.inert = true
    frame.style.cssText = screen.style.cssText
    Object.assign(frame.style, {
      position: 'absolute',
      left: `${screen.offsetLeft}px`,
      top: `${screen.offsetTop}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      overflow: 'hidden',
      pointerEvents: 'none'
    })
    for (const child of screen.children) {
      if (!child.matches('.xterm-helpers')) {
        frame.append(child.cloneNode(true))
      }
    }
    // Why inline: xterm positions decorations through `.xterm-screen` descendant rules the copy cannot match.
    const decorationCopies = frame.querySelectorAll<HTMLElement>('.xterm-decoration')
    for (const [index, decoration] of screen
      .querySelectorAll<HTMLElement>('.xterm-decoration')
      .entries()) {
      const copy = decorationCopies[index]
      if (copy) {
        const computed = getComputedStyle(decoration)
        copy.style.position = computed.position
        copy.style.zIndex = computed.zIndex
      }
    }
    for (const input of frame.querySelectorAll('textarea, input, .xterm-helpers')) {
      input.remove()
    }
    for (const node of frame.querySelectorAll('[id]')) {
      node.removeAttribute('id')
    }
    const copies = frame.querySelectorAll('canvas')
    for (const [index, canvas] of screen.querySelectorAll('canvas').entries()) {
      const copy = copies[index]
      const context = copy?.getContext('2d')
      if (!copy || !context) {
        return { kind: 'unavailable' }
      }
      Object.assign(copy.style, {
        position: 'absolute',
        left: `${canvas.offsetLeft}px`,
        top: `${canvas.offsetTop}px`
      })
      context.drawImage(canvas, 0, 0)
    }
    screen.after(frame)
    return { kind: 'retained', frame }
  } catch {
    // A lost/disposed canvas must not abort the authoritative replay.
    return { kind: 'unavailable' }
  }
}
