import { GUIDED_ROW_ATTRIBUTE } from './repo-header-action-button-class'

export const PROJECT_ACTIONS_TRIGGER_ATTRIBUTE = 'data-project-actions-trigger'
export const PROJECT_ACTIONS_VISIBILITY_ITEM_ATTRIBUTE = 'data-project-actions-visibility-item'

const MAX_ITEM_FRAMES = 12
const KEYBOARD_RETRY_FRAME = 6

// Why: Radix toggles its trigger on pointerdown, never on a synthetic click, so a
// plain click() on it looks like nothing happened at all.
function pressTrigger(trigger: HTMLElement): void {
  const init = { bubbles: true, cancelable: true, button: 0 }
  trigger.dispatchEvent(
    typeof PointerEvent === 'function'
      ? new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent('pointerdown', init)
  )
}

// Why: second attempt on the keyboard path Radix also supports, in case a pointer
// guard upstream swallowed the first one.
function pressTriggerByKeyboard(trigger: HTMLElement): void {
  trigger.focus()
  trigger.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
  )
}

// Why: the row's hover-revealed cluster must stay visible while the menu is open, and
// the menu content is portaled, so focus-within on the row cannot carry it. The hover
// reveal keys on an ancestor carrying `group`, so that element always exists where the
// cluster is hoverable; falling back to the trigger keeps it visible regardless.
function markGuidedRow(trigger: HTMLElement): HTMLElement {
  const row = trigger.closest<HTMLElement>('.group') ?? trigger
  row.setAttribute(GUIDED_ROW_ATTRIBUTE, '')
  return row
}

// Why: armed only once the item exists, otherwise any unrelated body mutation in the
// frames before the portal mounts would read as "menu closed" and clear the mark.
function clearGuidedRowWhenMenuCloses(doc: Document, row: HTMLElement): void {
  const observer = new MutationObserver(() => {
    if (doc.querySelector(`[${PROJECT_ACTIONS_VISIBILITY_ITEM_ATTRIBUTE}]`)) {
      return
    }
    row.removeAttribute(GUIDED_ROW_ATTRIBUTE)
    observer.disconnect()
  })
  observer.observe(doc.body, { childList: true, subtree: true })
}

type RevealAttempt = {
  doc: Document
  trigger: HTMLElement
  row: HTMLElement
  focusAtStart: Element | null
  onUnreachable: (() => void) | undefined
}

function focusVisibilityItem(attempt: RevealAttempt, framesLeft: number): void {
  const { doc, row } = attempt
  const item = doc.querySelector<HTMLElement>(`[${PROJECT_ACTIONS_VISIBILITY_ITEM_ATTRIBUTE}]`)
  if (item) {
    item.focus()
    clearGuidedRowWhenMenuCloses(doc, row)
    return
  }
  if (framesLeft <= 0) {
    // Why: the menu never opened, so drop the mark rather than leave the cluster stuck
    // revealed, and let the caller fall back to opening the dialog directly.
    row.removeAttribute(GUIDED_ROW_ATTRIBUTE)
    attempt.onUnreachable?.()
    return
  }
  // Why: the retry focuses the trigger, so it must not yank focus back from wherever the
  // user moved it in the frames since the click.
  if (framesLeft === KEYBOARD_RETRY_FRAME && doc.activeElement === attempt.focusAtStart) {
    pressTriggerByKeyboard(attempt.trigger)
  }
  // Why: menu content mounts on open, so the item can miss the first frames.
  requestAnimationFrame(() => focusVisibilityItem(attempt, framesLeft - 1))
}

// Why: the trigger is hover-revealed, so naming it in prose points at something that
// is not on screen; opening the real menu makes it appear and teaches where it lives.
// Returns false when the project header is unmounted; `onUnreachable` covers the later
// case where the header exists but the menu refuses to open.
export function revealProjectActionsMenu(
  repoId: string,
  options: { doc?: Document; onUnreachable?: () => void } = {}
): boolean {
  const doc = options.doc ?? document
  // Why: compare in JS rather than building an attribute selector, so a repo id can
  // never produce an invalid selector that throws instead of falling back.
  const trigger = [
    ...doc.querySelectorAll<HTMLElement>(`[${PROJECT_ACTIONS_TRIGGER_ATTRIBUTE}]`)
  ].find((candidate) => candidate.getAttribute(PROJECT_ACTIONS_TRIGGER_ATTRIBUTE) === repoId)
  if (!trigger) {
    return false
  }
  const row = markGuidedRow(trigger)
  const focusAtStart = doc.activeElement
  pressTrigger(trigger)
  focusVisibilityItem(
    { doc, trigger, row, focusAtStart, onUnreachable: options.onUnreachable },
    MAX_ITEM_FRAMES
  )
  return true
}
