type TerminalDeliveryCredit = {
  complete: () => void
  claimed: boolean
  credited: boolean
}

// Why: consumers must claim during deliver(); after it returns this synchronous slot is restored and unclaimed credit settles.
let currentDeliveryCredit: TerminalDeliveryCredit | null = null

function completeTerminalDeliveryCredit(credit: TerminalDeliveryCredit): void {
  // Why: queue splitting and discard paths can both settle one delivery.
  if (credit.credited) {
    return
  }
  credit.credited = true
  credit.complete()
}

/** Defers producer credit until the output scheduler consumes or discards the delivery. */
export function deliverTerminalDataWithDeferredCredit(
  complete: () => void,
  deliver: () => void
): void {
  const credit: TerminalDeliveryCredit = {
    complete,
    claimed: false,
    credited: false
  }
  const previousCredit = currentDeliveryCredit
  currentDeliveryCredit = credit
  try {
    deliver()
  } finally {
    currentDeliveryCredit = previousCredit
    if (!credit.claimed) {
      completeTerminalDeliveryCredit(credit)
    }
  }
}

/** Claims the current delivery for parse-deferred settlement by the output scheduler. */
export function takeCurrentTerminalDeliveryCredit(): (() => void) | null {
  const credit = currentDeliveryCredit
  if (!credit || credit.claimed) {
    return null
  }
  credit.claimed = true
  return () => completeTerminalDeliveryCredit(credit)
}
