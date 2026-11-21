const FOCUSED_PANE_FLASH_CLASS = 'pane-focus-rim-flash'
export const FOCUSED_PANE_FLASH_MS = 1_500

const flashTimersByPane = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

export function flashFocusedPaneRim(paneElement: HTMLElement): void {
  const existingTimer = flashTimersByPane.get(paneElement)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  // Remove then add to restart an in-progress rim animation on repeated clicks.
  paneElement.classList.remove(FOCUSED_PANE_FLASH_CLASS)
  void paneElement.offsetWidth
  paneElement.classList.add(FOCUSED_PANE_FLASH_CLASS)

  const timer = setTimeout(() => {
    paneElement.classList.remove(FOCUSED_PANE_FLASH_CLASS)
    flashTimersByPane.delete(paneElement)
  }, FOCUSED_PANE_FLASH_MS)
  flashTimersByPane.set(paneElement, timer)
}
