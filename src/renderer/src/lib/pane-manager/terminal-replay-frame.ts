// A transaction-local image, never a cached terminal buffer or an input target.
export function retainTerminalReplayFrame(
  screen: HTMLElement,
  refresh: () => void
): HTMLElement | null {
  const initialBounds = screen.getBoundingClientRect()
  if (initialBounds.width <= 0 || initialBounds.height <= 0 || !screen.childElementCount) {
    return null
  }
  try {
    // WebGL may discard its drawing buffer after compositing.
    if (screen.querySelector('canvas')) {
      refresh()
    }
    // Releasing xterm's render pause can flush a resize or replace its renderer.
    const bounds = screen.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) {
      return null
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
        return null
      }
      Object.assign(copy.style, {
        position: 'absolute',
        left: `${canvas.offsetLeft}px`,
        top: `${canvas.offsetTop}px`
      })
      context.drawImage(canvas, 0, 0)
    }
    screen.after(frame)
    return frame
  } catch {
    // A lost/disposed canvas must not abort the authoritative replay.
    return null
  }
}
