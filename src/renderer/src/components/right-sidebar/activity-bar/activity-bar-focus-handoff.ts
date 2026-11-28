const ACTIVITY_BAR_FOCUS_SELECTOR =
  '[data-activity-item-id], [data-activity-overflow-trigger], [data-activity-bar-menu]'
const ACTIVITY_TAB_SELECTOR =
  'button[data-activity-item-id], [role="menuitem"][data-activity-item-id]'

let pending: { cancel: () => void } | null = null

// Radix focus guards are sentinels that move focus around menus, not user focus choices.
function isUserFocusOutsideBar(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target !== document.body &&
    target.closest(ACTIVITY_BAR_FOCUS_SELECTOR) === null &&
    !target.hasAttribute('data-radix-focus-guard')
  )
}

export function cancelActivityBarFocusHandoff(): void {
  pending?.cancel()
}

// Moves focus to the neighbour two frames after hiding a tab, unless focus has
// already moved outside the activity bar, which means the user chose a newer target.
export function scheduleActivityBarFocusHandoff(neighbourId: string | undefined): void {
  cancelActivityBarFocusHandoff()
  let frame = 0
  let settled = false
  const onFocusIn = (event: FocusEvent): void => {
    if (isUserFocusOutsideBar(event.target)) {
      finish()
    }
  }
  const finish = (): void => {
    settled = true
    cancelAnimationFrame(frame)
    document.removeEventListener('focusin', onFocusIn, true)
    if (pending === handoff) {
      pending = null
    }
  }
  const handoff = { cancel: finish }
  pending = handoff
  document.addEventListener('focusin', onFocusIn, true)
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (settled) {
        return
      }
      if (isUserFocusOutsideBar(document.activeElement)) {
        finish()
        return
      }
      const tabs = Array.from(document.querySelectorAll<HTMLElement>(ACTIVITY_TAB_SELECTOR))
      const target = tabs.find((tab) => tab.dataset.activityItemId === neighbourId)
      // A neighbour under More is reached through its trigger, not the first tab.
      const more = document.querySelector<HTMLElement>('[data-activity-overflow-trigger]')
      ;(target ?? (neighbourId === undefined ? undefined : more) ?? tabs[0])?.focus()
      finish()
    })
  })
}
