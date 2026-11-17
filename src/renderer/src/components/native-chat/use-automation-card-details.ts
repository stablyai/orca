import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import {
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { subscribeAutomationDefinitionAcknowledgements } from '@/components/automations/events/automation-definition-acknowledgements'
import { subscribeAutomationHostInvalidation } from '@/components/automations/hosts/automation-host-invalidation-window-events'
import type { AutomationReceiptSource } from './automation-receipt-client'
import { automationReceiptSourceCurrent } from './automation-receipt-client'
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
    const refreshKnown = (): void => {
      const status = controller.getSnapshot().status
      if (status !== 'unverified' && status !== 'mismatch') {
        controller.changed()
      }
    }
    const unsubscribe = subscribeAutomationHostInvalidation((event) => {
      const authority = event.authority
      const matches =
        source.target.kind === 'local'
          ? authority.kind === 'desktop'
          : authority.kind === 'runtime' && authority.environmentId === source.target.environmentId
      if (matches && event.reason !== 'usage') {
        refreshKnown()
      }
    })
    const unsubscribeStore = useAppStore.subscribe((state, previous) => {
      if (
        state.runtimeStatusByEnvironmentId === previous.runtimeStatusByEnvironmentId &&
        state.runtimeEnvironments === previous.runtimeEnvironments
      ) {
        return
      }
      if (!automationReceiptSourceCurrent(source)) {
        controller.invalidate()
      }
    })
    const unsubscribeAcks = subscribeAutomationDefinitionAcknowledgements(
      ({ target, automationId }) => {
        if (
          source.automationId === automationId &&
          source.target.kind === target.kind &&
          (source.target.kind === 'local' ||
            (target.kind === 'environment' && source.target.environmentId === target.environmentId))
        ) {
          refreshKnown()
        }
      }
    )
    const invalidateEnvironment = (ids: readonly string[]): void => {
      if (source.target.kind === 'environment' && ids.includes(source.target.environmentId)) {
        controller.invalidate()
      }
    }
    const unsubscribeRetired = onRuntimeEnvironmentsRetired(invalidateEnvironment)
    const unsubscribeRepaired = onRuntimeEnvironmentRevisionsChanged(invalidateEnvironment)
    return () => {
      unsubscribe()
      unsubscribeStore()
      unsubscribeAcks()
      unsubscribeRetired()
      unsubscribeRepaired()
      controller.dispose()
    }
  }, [controller, source])
  return { details, controller }
}
