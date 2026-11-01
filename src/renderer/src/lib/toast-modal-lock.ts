import { createElement, type ReactNode } from 'react'
import { MODAL_OVERLAY_CHILD_SELECTOR } from '@/lib/body-overlay-attributes'
import { translate } from '@/i18n/i18n'

/** Marks a toast control that may run above a modal: it must not change UI behind the modal. */
export const TOAST_MODAL_SAFE_ATTRIBUTE = 'data-toast-modal-safe'
const MODAL_SAFE_SELECTOR = `[${TOAST_MODAL_SAFE_ATTRIBUTE}]`
const TOAST_CONTROL_SELECTOR = 'button, a[href], [role="button"]'
// Our own marker, so we only ever clear aria-disabled/title that this lock set.
const LOCKED_CONTROL_ATTRIBUTE = 'data-toast-modal-locked'

/** Sonner action labels can't carry attributes, so the opt-in rides on the label inside the button. */
export function modalSafeToastActionLabel(label: ReactNode): ReactNode {
  return createElement('span', { [TOAST_MODAL_SAFE_ATTRIBUTE]: '' }, label)
}

// Why: scope to real modals; Radix menus/selects also set body pointer-events:none.
export function isModalOverlayOpen(element: Element): boolean {
  return element.ownerDocument.body.querySelector(MODAL_OVERLAY_CHILD_SELECTOR) !== null
}

function isAlwaysAllowedControl(control: Element): boolean {
  return (
    control.matches('[data-close-button]') ||
    control.matches(MODAL_SAFE_SELECTOR) ||
    control.querySelector(MODAL_SAFE_SELECTOR) !== null
  )
}

/** True when a click on this toast target must not run because a modal owns the interaction lock. */
export function isModalLockedToastTarget(target: Element): boolean {
  if (target.closest('[data-sonner-toast]') === null || !isModalOverlayOpen(target)) {
    return false
  }
  const control = target.closest(TOAST_CONTROL_SELECTOR)
  return control === null || !isAlwaysAllowedControl(control)
}

/** Mirror the lock onto blocked controls so assistive tech and hover titles match the disabled look. */
export function syncToastModalLockAttributes(root: Element): void {
  const locked = isModalOverlayOpen(root)
  const title = translate('components.toast.modalLocked', 'Close the dialog to use this')
  for (const control of root.querySelectorAll(
    `[data-sonner-toast] :is(${TOAST_CONTROL_SELECTOR})`
  )) {
    const block = locked && !isAlwaysAllowedControl(control)
    if (block && !control.hasAttribute(LOCKED_CONTROL_ATTRIBUTE)) {
      // Value records whether the title is ours, so a control's own tooltip survives unlock.
      const ownsTitle = !control.hasAttribute('title')
      control.setAttribute(LOCKED_CONTROL_ATTRIBUTE, ownsTitle ? 'title' : '')
      control.setAttribute('aria-disabled', 'true')
      if (ownsTitle) {
        control.setAttribute('title', title)
      }
    } else if (!block && control.hasAttribute(LOCKED_CONTROL_ATTRIBUTE)) {
      if (control.getAttribute(LOCKED_CONTROL_ATTRIBUTE) === 'title') {
        control.removeAttribute('title')
      }
      control.removeAttribute(LOCKED_CONTROL_ATTRIBUTE)
      control.removeAttribute('aria-disabled')
    }
  }
}

/** For a modal-safe action that opens a trigger-less dialog: pass the result as that dialog's
 *  onCloseAutoFocus so focus returns to the modal underneath instead of falling to body. */
export function captureDialogReturnFocus(): (event: Event) => void {
  const previous = document.activeElement
  return (event) => {
    if (previous instanceof HTMLElement && previous.isConnected) {
      event.preventDefault()
      previous.focus({ preventScroll: true })
    }
  }
}
