type TerminalDeliveryCredit = {
  complete: () => void
  open: boolean
  pendingClaims: number
  completed: boolean
}

// Why: claims are synchronous; nesting restores an outer delivery after an inner callback returns.
let currentDeliveryCredit: TerminalDeliveryCredit | null = null

function completeTerminalDeliveryCredit(credit: TerminalDeliveryCredit): void {
  if (credit.completed || credit.open || credit.pendingClaims > 0) {
    return
  }
  credit.completed = true
  credit.complete()
}

/** Defers producer credit until every output scheduler consumer parses or discards it. */
export function deliverTerminalDataWithDeferredCredit(
  complete: () => void,
  deliver: () => void
): void {
  const credit: TerminalDeliveryCredit = {
    complete,
    open: true,
    pendingClaims: 0,
    completed: false
  }
  const previousCredit = currentDeliveryCredit
  currentDeliveryCredit = credit
  try {
    deliver()
  } finally {
    currentDeliveryCredit = previousCredit
    credit.open = false
    completeTerminalDeliveryCredit(credit)
  }
}

export function takeCurrentTerminalDeliveryCredit(): (() => void) | null {
  const credit = currentDeliveryCredit
  if (!credit || !credit.open) {
    return null
  }
  credit.pendingClaims += 1
  let settled = false
  return () => {
    if (settled) {
      return
    }
    settled = true
    credit.pendingClaims -= 1
    completeTerminalDeliveryCredit(credit)
  }
}
