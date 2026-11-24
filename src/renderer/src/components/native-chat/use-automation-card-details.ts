import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { subscribeAutomationDefinitionAcknowledgements } from '@/components/automations/events/automation-definition-acknowledgements'
import { subscribeAutomationHostInvalidation } from '@/components/automations/hosts/automation-host-invalidation-window-events'
import type { AutomationReceiptSource } from './automation-receipt-client'
import {
  AutomationCardDetailsController,
  receiptDetailsTransport
} from './automation-card-details-controller'

/** Mounted only by an intentional disclosure; folded receipts acquire nothing. */
export function useAutomationCardDetails(source: AutomationReceiptSource | null) {
  const controller = useMemo(
    () => new AutomationCardDetailsController(source ? receiptDetailsTransport(source) : null),
    [source]
  )
  const details = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    controller.start()
    if (!source) {
      return controller.dispose
    }
    // An unverified or mismatched card stays as it is until it is opened again.
    const known = (): boolean => {
      const status = controller.getSnapshot().status
      return status !== 'unverified' && status !== 'mismatch'
    }
    const unsubscribe = subscribeAutomationHostInvalidation((event) => {
      const authority = event.authority
      const matches =
        source.target.kind === 'local'
          ? authority.kind === 'desktop'
          : authority.kind === 'runtime' && authority.environmentId === source.target.environmentId
      if (matches && event.reason !== 'usage' && known()) {
        controller.hostChanged(event.reason)
      }
    })
    // Another surface's write to this automation; this card's own write acknowledges while mutating.
    const unsubscribeAcks = subscribeAutomationDefinitionAcknowledgements(
      ({ target, automationId }) => {
        if (
          source.automationId === automationId &&
          source.target.kind === target.kind &&
          (source.target.kind === 'local' ||
            (target.kind === 'environment' &&
              source.target.environmentId === target.environmentId)) &&
          known()
        ) {
          controller.changed()
        }
      }
    )
    // The host watch is the controller's: it outlives a hidden pane while a write is in flight.
    return () => {
      unsubscribe()
      unsubscribeAcks()
      controller.dispose()
    }
  }, [controller, source])
  return { details, controller }
}
