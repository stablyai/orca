/**
 * Swallow the click that follows a completed header drag.
 *
 * Why: the pointerup that ends a promoted drag is followed by a click on the
 * drag handle, which would also toggle the section the user just reordered.
 * The listener removes itself on the first click; the returned timeout handle
 * is the fallback for a drop that produces no click.
 */
export function swallowNextClickOnDragHandle(handleEl: HTMLElement): ReturnType<typeof setTimeout> {
  const swallow = (event: MouseEvent): void => {
    const target = event.target as Node | null
    if (target && handleEl.contains(target)) {
      event.stopPropagation()
      event.preventDefault()
    }
    window.removeEventListener('click', swallow, true)
  }
  window.addEventListener('click', swallow, true)
  return setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}
