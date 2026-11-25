import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { onRuntimeEnvironmentsRetired } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'
import { subscribeAutomationHostInvalidation } from '../hosts/automation-host-invalidation-window-events'
import { automationAuthorityCatalogKey } from '../hosts/automation-host-catalog-types'
import { evaluateAutomationOwner } from '../hosts/automation-host-owner'
import { listAutomationRunsPageForOwner } from '../hosts/automation-scoped-list-client'
import { readAutomationRunForOwner, showAutomationForOwner } from '../hosts/automation-owner-reads'
import { AutomationDetailsController } from './automation-details-controller'
import type { AutomationDetailsDeps, AutomationDetailsSnapshot } from './automation-details-model'

export const AUTOMATION_DETAILS_DEPS: AutomationDetailsDeps = {
  showAutomation: showAutomationForOwner,
  listRunsPage: listAutomationRunsPageForOwner,
  readRun: readAutomationRunForOwner,
  evaluateOwner: evaluateAutomationOwner
}

function ownerKey(owner: AutomationOwnerRef): string {
  return JSON.stringify(owner)
}

/**
 * One automation read through `owner`: re-read on its host's automation changes and when contact
 * with the host comes back, never polled. One controller per owner and automation.
 */
export function useAutomationDetails(input: {
  owner: AutomationOwnerRef
  automationId: string
  recentLimit: number
  runId?: string | null
  deps?: AutomationDetailsDeps
}): { controller: AutomationDetailsController; snapshot: AutomationDetailsSnapshot } {
  const { owner, automationId, recentLimit } = input
  const deps = input.deps ?? AUTOMATION_DETAILS_DEPS
  const key = JSON.stringify([ownerKey(owner), automationId, recentLimit])
  // One controller per owner and automation; the asked-for run when it's made is its first pin.
  const make = (): {
    key: string
    deps: AutomationDetailsDeps
    controller: AutomationDetailsController
  } => ({
    key,
    deps,
    controller: new AutomationDetailsController(
      owner,
      automationId,
      recentLimit,
      deps,
      input.runId ?? null
    )
  })
  const [current, setCurrent] = useState(make)
  let controller = current.controller
  if (current.key !== key || current.deps !== deps) {
    const next = make()
    setCurrent(next)
    controller = next.controller
  }
  useEffect(() => {
    controller.start()
    const authority = controller.getSnapshot().owner.authority
    const catalogKey = automationAuthorityCatalogKey(authority)
    const unsubscribeChanges = subscribeAutomationHostInvalidation((event) => {
      if (automationAuthorityCatalogKey(event.authority) === catalogKey) {
        controller.reload()
      }
    })
    const environmentId = authority.kind === 'runtime' ? authority.environmentId : null
    const unsubscribeContact = environmentId
      ? subscribeRuntimeHostContactRegained(environmentId, () => controller.reload())
      : () => undefined
    const unsubscribeRetired = environmentId
      ? onRuntimeEnvironmentsRetired((ids) => {
          if (ids.includes(environmentId)) {
            // Retirement fires before the new revisions publish; re-check once they have.
            queueMicrotask(() => controller.recheckOwner())
          }
        })
      : () => undefined
    return () => {
      unsubscribeChanges()
      unsubscribeContact()
      unsubscribeRetired()
      controller.dispose()
    }
  }, [controller])
  const runId = input.runId ?? null
  useEffect(() => {
    controller.selectRun(runId)
  }, [controller, runId])
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return { controller, snapshot }
}
