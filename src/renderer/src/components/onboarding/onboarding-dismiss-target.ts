type OnboardingPointerTarget = EventTarget & {
  closest: Element['closest']
}

const ONBOARDING_INTERACTIVE_LAYER_SELECTOR = [
  '[data-onboarding-modal]',
  '[data-slot="dialog-content"]',
  '[data-slot="dialog-overlay"]',
  '[data-slot="select-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="context-menu-sub-content"]',
  '[data-slot="sheet-content"]',
  '[data-slot="hover-card-content"]'
].join(', ')

function hasClosest(target: EventTarget | null): target is OnboardingPointerTarget {
  return typeof (target as { closest?: unknown } | null)?.closest === 'function'
}

export function shouldRequestOnboardingSkipConfirmation(event: {
  button: number
  target: EventTarget | null
}): boolean {
  if (event.button !== 0 || !hasClosest(event.target)) {
    return false
  }
  // Radix portals still bubble through React even when their DOM targets sit outside the modal.
  return !event.target.closest(ONBOARDING_INTERACTIVE_LAYER_SELECTOR)
}
