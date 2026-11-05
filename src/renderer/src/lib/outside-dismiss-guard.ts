// Use only preventDefault to keep the dirty-dismiss guard independent of Radix types.
type PreventableOutsideEvent = { preventDefault: () => void }

/** Dirty drafts block backdrop dismissal while Escape/Cancel/× explicitly discard. Read dirty state at event time; recreate the handler each render so Radix receives the latest predicate. */
export function preventOutsideDismissWhenDirty(
  isDirty: () => boolean
): (event: PreventableOutsideEvent) => void {
  return (event) => {
    if (isDirty()) {
      event.preventDefault()
    }
  }
}
