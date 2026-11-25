import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AutomationReceiptSource } from './automation-receipt-client'
import {
  AutomationCardDetailsController,
  receiptDetailsTransport
} from './automation-card-details-controller'

/** Mounted only by an intentional disclosure; folded receipts acquire nothing. Reads current
 *  settings on open; changes made elsewhere show the next time it opens. */
export function useAutomationCardDetails(source: AutomationReceiptSource | null) {
  const controller = useMemo(
    () => new AutomationCardDetailsController(source ? receiptDetailsTransport(source) : null),
    [source]
  )
  const details = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  // The host watch is the controller's: it outlives a hidden pane while a write is in flight.
  useEffect(() => {
    controller.start()
    return controller.dispose
  }, [controller])
  return { details, controller }
}
