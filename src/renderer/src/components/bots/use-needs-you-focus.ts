// Keyboard focus in the Needs you card: which row holds it, and where it goes when a re-sort
// moves that row or its row leaves.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

/** Each row's wrapper names its need, so focus can find a row's controls. */
const NEED_KEY_ATTRIBUTE = 'data-need-key'
/** Held for a control past the rows (the footer): when it goes, the nearest rows are above. */
const AFTER_ROWS = ':after-rows'

/** The rows shown now, read from the card itself, in order: never stale, whoever commits. */
function shownRows(card: HTMLElement): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>()
  for (const row of card.querySelectorAll<HTMLElement>(`[${NEED_KEY_ATTRIBUTE}]`)) {
    const key = row.getAttribute(NEED_KEY_ATTRIBUTE)
    if (key && !row.hidden) {
      rows.set(key, row)
    }
  }
  return rows
}

function rowControls(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')]
}

function focuses(control: HTMLElement): boolean {
  // The offline panel turns its controls off through a disabled fieldset.
  if (control.matches(':disabled') || control.closest('fieldset[disabled]')) {
    return false
  }
  control.focus({ preventScroll: true })
  return document.activeElement === control
}

/** Focus a removed or moved node had goes to the page itself. */
export function focusFellToNothing(): boolean {
  return document.activeElement === null || document.activeElement === document.body
}

type HeldFocus = { key: string; control: HTMLElement }

export type NeedsYouFocus = {
  /** The row holding keyboard focus, which stays shown past the cap. */
  focusedKey: string | null
  cardRef: React.RefObject<HTMLDivElement | null>
  onFocus: (event: React.FocusEvent) => void
  onBlur: (event: React.FocusEvent) => void
  held: React.RefObject<HeldFocus | null>
  forget: () => void
}

/** Tracks the row holding focus inside the card; leaving the card forgets it. */
export function useNeedsYouFocus(): NeedsYouFocus {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const last = useRef<HeldFocus | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const forget = useCallback(() => {
    last.current = null
    setFocusedKey(null)
  }, [])

  const onFocus = useCallback((event: React.FocusEvent) => {
    const control = event.target
    if (!(control instanceof HTMLElement)) {
      return
    }
    const key = control.closest(`[${NEED_KEY_ATTRIBUTE}]`)?.getAttribute(NEED_KEY_ATTRIBUTE)
    // The footer holds no row, so none stays shown past the cap; if it leaves, focus goes
    // back to the rows above it.
    last.current = { key: key ?? AFTER_ROWS, control }
    setFocusedKey(key ?? null)
  }, [])

  const onBlur = useCallback(
    (event: React.FocusEvent) => {
      const next = event.relatedTarget
      if (next instanceof Node && cardRef.current?.contains(next)) {
        return
      }
      if (next) {
        forget()
        return
      }
      // No target: a click on nothing, a window switch, or the node leaving in a commit. Decide
      // once that commit's refocus has run.
      if (leaveTimer.current) {
        clearTimeout(leaveTimer.current)
      }
      leaveTimer.current = setTimeout(() => {
        leaveTimer.current = null
        if (!cardRef.current?.contains(document.activeElement)) {
          forget()
        }
      }, 0)
    },
    [forget]
  )

  useEffect(
    () => () => {
      if (leaveTimer.current) {
        clearTimeout(leaveTimer.current)
      }
    },
    []
  )

  return { focusedKey, cardRef, onFocus, onBlur, held: last, forget }
}

/** Lets a row tell the card it committed on its own, e.g. its approval became a question. */
export const NeedsYouRowCommit = createContext<(() => void) | null>(null)

/** Every row calls this: a commit of the row alone can remove the focused control. */
export function useNeedsYouRowCommit(): void {
  const committed = useContext(NeedsYouRowCommit)
  // Without deps: the row's controls can change on any of its commits.
  useLayoutEffect(() => committed?.())
}

/**
 * Focus back on the held control, else the first enabled control of the rows shown now: those
 * after the held row in the last order first, then those before it, nearest first, then new ones.
 */
function restore(card: HTMLElement | null, held: HeldFocus, before: readonly string[]): boolean {
  if (!card) {
    return false
  }
  if (card.contains(held.control) && focuses(held.control)) {
    return true
  }
  const shown = shownRows(card)
  const at = held.key === AFTER_ROWS ? before.length : before.indexOf(held.key)
  const candidates = new Set([
    held.key,
    ...(at === -1 ? before : before.slice(at + 1)),
    ...(at === -1 ? [] : before.slice(0, at).toReversed()),
    ...shown.keys()
  ])
  for (const key of candidates) {
    const row = shown.get(key)
    for (const control of row ? rowControls(row) : []) {
      if (focuses(control)) {
        return true
      }
    }
  }
  return false
}

/**
 * Runs after every commit of the card, and of any row alone (the returned callback, given to rows
 * through NeedsYouRowCommit). A re-sort that moves the focused row's node drops focus; it goes
 * back to the same control. If that control is gone, focus moves to the first enabled control in
 * the rows after it, then the rows before it, nearest first, else to `fallback`. `order` is every
 * row's key in card order, folded or not, so a row a removal brings up counts as after it.
 */
export function useNeedsYouRefocus(
  focus: NeedsYouFocus,
  order: readonly string[],
  fallback: React.RefObject<HTMLElement | null> | undefined
): () => void {
  const { held: last } = focus
  const orderBefore = useRef<readonly string[]>(order)
  // The rows' callback stays the same function, so a card render doesn't re-render every row.
  const latest = useRef({ focus, fallback })
  // Only focus this commit dropped comes back; focus that left the card before it stays where it went.
  const focusedAtRender = typeof document === 'undefined' ? null : document.activeElement
  // Without deps: a row's own controls can change on a commit that keeps the same rows.
  useLayoutEffect(() => {
    latest.current = { focus, fallback }
    const before = orderBefore.current
    orderBefore.current = order
    const held = last.current
    // Dropped means fell to nothing: focus another effect of this commit put elsewhere stays there.
    const dropped =
      focusedAtRender !== null &&
      focusedAtRender !== document.activeElement &&
      (focusedAtRender === held?.control || !focusedAtRender.isConnected) &&
      focusFellToNothing()
    if (!held || !dropped) {
      return
    }
    settle(focus, fallback, before)
  })
  return useCallback(() => {
    const { focus: current, fallback: currentFallback } = latest.current
    const held = current.held.current
    // A row's own commit moves no node, so only a removed control loses focus, and only to
    // nothing: focus the owner took elsewhere stays there.
    if (!held || held.control.isConnected || !focusFellToNothing()) {
      return
    }
    // The order a row-only commit keeps; which rows show is read from the card, so it's current.
    settle(current, currentFallback, orderBefore.current)
  }, [])
}

/** Puts focus back in the card, else on `fallback`. */
function settle(
  { cardRef, held: last, forget }: NeedsYouFocus,
  fallback: React.RefObject<HTMLElement | null> | undefined,
  before: readonly string[]
): void {
  const held = last.current
  if (held && !restore(cardRef.current, held, before)) {
    forget()
    fallback?.current?.focus({ preventScroll: true })
  }
}
