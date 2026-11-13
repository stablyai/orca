import {
  copyBrowserPageHandles,
  annotateBrowserPageHandles
} from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import { endBrowserPageInitializationAction } from '../../components/browser-pane/navigate/browser-page-deferred-navigation'
import { useAppStore } from '@/store'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { RuntimeMobileSessionBrowserTab } from '../../../../shared/runtime-mobile-session-tab-contracts'
import type { RemoteBrowserPageHandle } from '@/store/slices/browser/browser-slice-contract'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '../rpc/environment-revisions/runtime-environment-revision'

export type BrowserInitializationDelivery = {
  environmentId: string
  pairingRevision: number | undefined
  live: boolean
  publishedPresentationCount: number
}
export type BrowserInitializationPresentation = {
  disposition: 'pending' | 'stopped' | 'unavailable'
  delivery: BrowserInitializationDelivery
  receivedFrame: number
}
type Receipt = { delivery: BrowserInitializationDelivery; receivedFrame: number }
type DeliveryEntry = {
  delivery: BrowserInitializationDelivery
  transportGeneration: number
}
const deliveries = new Map<string, DeliveryEntry>()
const receipts = new WeakMap<RuntimeMobileSessionTabsResult, Receipt>()

export function captureBrowserInitializationDelivery(
  environmentId: string
): BrowserInitializationDelivery {
  const revision = getRuntimeEnvironmentRevision(environmentId)
  let entry = deliveries.get(environmentId)
  if (!entry || entry.delivery.pairingRevision !== revision) {
    if (entry) {
      entry.delivery.live = false
    }
    entry = {
      delivery: {
        environmentId,
        pairingRevision: revision,
        live: true,
        publishedPresentationCount: 0
      },
      transportGeneration: -1
    }
    deliveries.set(environmentId, entry)
  } else if (!entry.delivery.live) {
    entry.delivery = {
      environmentId,
      pairingRevision: revision,
      live: true,
      publishedPresentationCount: 0
    }
  }
  return entry.delivery
}

export function isBrowserInitializationDeliveryCurrent(
  delivery: BrowserInitializationDelivery
): boolean {
  return (
    delivery.live &&
    deliveries.get(delivery.environmentId)?.delivery === delivery &&
    getRuntimeEnvironmentRevision(delivery.environmentId) === delivery.pairingRevision
  )
}

export function recordBrowserInitializationReceipt(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  delivery = captureBrowserInitializationDelivery(environmentId)
): void {
  // Cached visibility frames keep their original connection even when reapplied after reconnect.
  if (!receipts.has(snapshot)) {
    receipts.set(snapshot, { delivery, receivedFrame })
  }
}

export function carryBrowserInitializationReceipt(
  source: RuntimeMobileSessionTabsResult,
  target: RuntimeMobileSessionTabsResult
): void {
  const receipt = receipts.get(source)
  if (receipt) {
    receipts.set(target, receipt)
  }
}

export function browserInitializationPresentation(
  snapshot: RuntimeMobileSessionTabsResult,
  tab: RuntimeMobileSessionBrowserTab,
  previous: RemoteBrowserPageHandle | undefined
): BrowserInitializationPresentation | undefined {
  const receipt = receipts.get(snapshot)
  if (!receipt || !isBrowserInitializationDeliveryCurrent(receipt.delivery)) {
    return previous?.initializationPresentation
  }
  if (!tab.initializationState) {
    return undefined
  }
  const prior = previous?.initializationPresentation
  if (prior?.delivery === receipt.delivery && prior.disposition === tab.initializationState) {
    return prior
  }
  return { ...receipt, disposition: tab.initializationState }
}

export function browserInitializationReceiptStale(
  snapshot: RuntimeMobileSessionTabsResult
): boolean {
  const receipt = receipts.get(snapshot)
  return Boolean(receipt && !isBrowserInitializationDeliveryCurrent(receipt.delivery))
}

export function browserInitializationReceiptCurrent(
  snapshot: RuntimeMobileSessionTabsResult
): boolean {
  const receipt = receipts.get(snapshot)
  return Boolean(receipt && isBrowserInitializationDeliveryCurrent(receipt.delivery))
}

function revokeBrowserInitializationDeliveries(
  environmentIds: Iterable<string>,
  remove = false
): void {
  const affected = new Set<string>()
  for (const environmentId of environmentIds) {
    const entry = deliveries.get(environmentId)
    if (!entry || (!entry.delivery.live && !remove)) {
      continue
    }
    const presented = entry.delivery.publishedPresentationCount > 0
    entry.delivery.live = false
    entry.delivery.publishedPresentationCount = 0
    if (remove) {
      deliveries.delete(environmentId)
    }
    if (presented) {
      affected.add(environmentId)
    }
  }
  if (affected.size === 0) {
    return
  }
  useAppStore.setState((state) => {
    let handles = state.remoteBrowserPageHandlesByPageId
    for (const pageId in state.remoteBrowserPageHandlesByPageId) {
      if (!Object.hasOwn(state.remoteBrowserPageHandlesByPageId, pageId)) {
        continue
      }
      const handle = state.remoteBrowserPageHandlesByPageId[pageId]
      const presentation = handle.initializationPresentation
      if (
        !affected.has(handle.environmentId) ||
        !presentation ||
        presentation.disposition === 'unavailable' ||
        isBrowserInitializationDeliveryCurrent(presentation.delivery)
      ) {
        continue
      }
      if (handles === state.remoteBrowserPageHandlesByPageId) {
        handles = copyBrowserPageHandles(handles)
      }
      annotateBrowserPageHandles(handles, [pageId])
      endBrowserPageInitializationAction(pageId)
      handles[pageId] = {
        ...handle,
        initializationPresentation: { ...presentation, disposition: 'unavailable' }
      }
    }
    return handles === state.remoteBrowserPageHandlesByPageId
      ? state
      : { remoteBrowserPageHandlesByPageId: handles }
  })
}

/** The app lifetime observes transport death even while workspace subscriptions are parked. */
export function installBrowserInitializationPresentationLifetime(): () => void {
  const stopDiagnostics = window.api?.runtimeEnvironments?.onSharedControlDiagnostics?.(
    ({ environmentId, transportGeneration, diagnostics }) => {
      const entry = deliveries.get(environmentId)
      if (!entry || transportGeneration < entry.transportGeneration) {
        return
      }
      if (transportGeneration > entry.transportGeneration && entry.transportGeneration !== -1) {
        revokeBrowserInitializationDeliveries([environmentId])
      }
      entry.transportGeneration = transportGeneration
      if (diagnostics.state === 'closed' || diagnostics.state === 'reconnecting') {
        revokeBrowserInitializationDeliveries([environmentId])
      }
    }
  )
  const retire = (ids: readonly string[]): void => {
    revokeBrowserInitializationDeliveries(ids, true)
  }
  const stopRetirement = onRuntimeEnvironmentsRetired(retire)
  const stopPairing = onRuntimeEnvironmentRevisionsChanged(retire)
  const stopStatus = useAppStore.subscribe((state, previous) => {
    if (state.runtimeStatusByEnvironmentId === previous.runtimeStatusByEnvironmentId) {
      return
    }
    const retired: string[] = []
    for (const [id] of deliveries) {
      const snapshot = state.runtimeStatusByEnvironmentId.get(id)?.snapshot
      if (
        snapshot &&
        (snapshot.retired || snapshot.verification === 'blocked') &&
        snapshot.pairingRevision === getRuntimeEnvironmentRevision(id)
      ) {
        retired.push(id)
      }
    }
    revokeBrowserInitializationDeliveries(retired, true)
  })
  return () => {
    stopDiagnostics?.()
    stopRetirement()
    stopPairing()
    stopStatus()
    revokeBrowserInitializationDeliveries(deliveries.keys(), true)
  }
}
