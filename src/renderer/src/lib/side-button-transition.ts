export type SideButtonTransition = { button: 3 | 4; phase: 'press' | 'release' }

/**
 * A side Back/Forward press or release. A button pressed or released while another is held
 * arrives as `pointermove` with `button` set (Pointer Events chorded-button transition).
 */
export function readSideButtonTransition(event: PointerEvent): SideButtonTransition | null {
  const { button } = event
  if (button !== 3 && button !== 4) {
    return null
  }
  if (event.type === 'pointerdown') {
    return { button, phase: 'press' }
  }
  if (event.type === 'pointerup') {
    return { button, phase: 'release' }
  }
  if (event.type === 'pointermove') {
    // Why the bitmask: button 3 is bit 8, button 4 is bit 16; set means it just went down.
    const mask = button === 3 ? 8 : 16
    return { button, phase: (event.buttons & mask) !== 0 ? 'press' : 'release' }
  }
  return null
}
