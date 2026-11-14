/** Prevent the post-drag click from toggling the reordered section; time out if no click arrives. */
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
