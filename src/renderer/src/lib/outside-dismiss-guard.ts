// Why a structural event shape and not Radix's event type: this module stays dependency-free and
// the handler only needs `preventDefault`, which every outside-dismiss event provides.
type PreventableOutsideEvent = { preventDefault: () => void }

/**
 * Block Radix outside-dismiss while `isDirty()` is true, so an accidental backdrop click cannot
 * discard a draft. Escape / Cancel / × stay the explicit discard paths.
 *
 * Why a predicate instead of a boolean: callers that mutate their dirty baseline in an effect
 * need the check evaluated at event time, not captured at render. Do not memoize the returned
 * handler — it must be recreated each render so Radix reads the latest predicate.
 */
export function preventOutsideDismissWhenDirty(
  isDirty: () => boolean
): (event: PreventableOutsideEvent) => void {
  return (event) => {
    if (isDirty()) {
      event.preventDefault()
    }
  }
}
