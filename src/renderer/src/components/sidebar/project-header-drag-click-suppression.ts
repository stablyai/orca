/**
 * Swallows the click that fires right after a promoted project-header drag, so
 * releasing the pointer over the header does not also toggle its collapse.
 * Returns the timeout that tears the capture listener down; the caller must
 * clear it if the hook unmounts first.
 */
export function suppressClickAfterProjectHeaderDrag(
  handleEl: HTMLElement,
  onSettled: () => void
): ReturnType<typeof setTimeout> {
  const swallow = (event: MouseEvent): void => {
    const target = event.target as Node | null
    if (target && handleEl.contains(target)) {
      event.stopPropagation()
      event.preventDefault()
    }
    window.removeEventListener('click', swallow, true)
  }
  window.addEventListener('click', swallow, true)
  return setTimeout(() => {
    window.removeEventListener('click', swallow, true)
    onSettled()
  }, 0)
}
