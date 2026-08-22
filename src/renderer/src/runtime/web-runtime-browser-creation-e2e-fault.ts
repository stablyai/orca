import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { e2eConfig } from '@/lib/e2e-config'

type BrowserCreationFaultSnapshot = {
  armed: boolean
  capabilityRejectionArmed: boolean
  createdPageId: string | null
  provisionalPageId: string | null
  requestedKnownPageId: boolean | null
  releasedPageSnapshotSuppressed: boolean
  suppressedPageIds: string[]
}

type BrowserCreationFaultApi = {
  arm: () => void
  armCapabilityRejection: () => void
  release: () => boolean
  releaseWithPublicationLag: () => boolean
  reset: () => void
  snapshot: () => BrowserCreationFaultSnapshot
}

type BrowserCreationFaultWindow = Window & {
  __webRuntimeBrowserCreationFault?: BrowserCreationFaultApi
}

let armed = false
let capabilityRejectionArmed = false
let createdPageId: string | null = null
let provisionalPageId: string | null = null
let requestedKnownPageId: boolean | null = null
let failNextReconciliation = false
let suppressNextReleasedPageSnapshot = false
let releasedPageSnapshotSuppressed = false
let releaseCreatedPage: (() => void) | null = null
let createdPageBarrier: Promise<void> | null = null
const suppressedPageIds = new Set<string>()
const MAX_SUPPRESSED_PAGE_IDS = 128

function resetFault(): void {
  releaseCreatedPage?.()
  armed = false
  capabilityRejectionArmed = false
  createdPageId = null
  provisionalPageId = null
  requestedKnownPageId = null
  failNextReconciliation = false
  suppressNextReleasedPageSnapshot = false
  releasedPageSnapshotSuppressed = false
  releaseCreatedPage = null
  createdPageBarrier = null
  suppressedPageIds.clear()
}

function exposeFaultApi(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  const target = window as BrowserCreationFaultWindow
  target.__webRuntimeBrowserCreationFault ??= {
    arm: () => {
      resetFault()
      armed = true
      createdPageBarrier = new Promise<void>((resolve) => {
        releaseCreatedPage = resolve
      })
    },
    armCapabilityRejection: () => {
      resetFault()
      capabilityRejectionArmed = true
    },
    release: () => {
      if (!armed || !createdPageId || !releaseCreatedPage) {
        return false
      }
      failNextReconciliation = true
      const release = releaseCreatedPage
      releaseCreatedPage = null
      release()
      return true
    },
    releaseWithPublicationLag: () => {
      if (!armed || !createdPageId || !releaseCreatedPage) {
        return false
      }
      suppressNextReleasedPageSnapshot = true
      const release = releaseCreatedPage
      releaseCreatedPage = null
      release()
      return true
    },
    reset: resetFault,
    snapshot: () => ({
      armed,
      capabilityRejectionArmed,
      createdPageId,
      provisionalPageId,
      requestedKnownPageId,
      releasedPageSnapshotSuppressed,
      suppressedPageIds: [...suppressedPageIds]
    })
  }
}

exposeFaultApi()

export function throwIfE2eWebRuntimeBrowserCapabilityUnavailable(): void {
  if (!e2eConfig.exposeStore || !capabilityRejectionArmed) {
    return
  }
  capabilityRejectionArmed = false
  throw new Error('E2E forced browser capability rejection')
}

export async function pauseAfterE2eWebRuntimeBrowserCreate(
  remotePageId: string,
  clientProvisionalPageId: string,
  clientRequestedKnownPageId: boolean
): Promise<void> {
  if (!e2eConfig.exposeStore || !armed || !createdPageBarrier) {
    return
  }
  createdPageId = remotePageId
  provisionalPageId = clientProvisionalPageId
  requestedKnownPageId = clientRequestedKnownPageId
  await createdPageBarrier
}

export function throwIfE2eWebRuntimeBrowserReconciliationFails(): void {
  if (!e2eConfig.exposeStore || !failNextReconciliation) {
    return
  }
  failNextReconciliation = false
  throw new Error('E2E forced session-tabs reconciliation timeout')
}

export function suppressE2eWebRuntimeBrowserSnapshot(
  snapshot: RuntimeMobileSessionTabsResult
): boolean {
  if (!e2eConfig.exposeStore || !armed) {
    return false
  }
  const pageIds = snapshot.tabs.flatMap((tab) =>
    tab.type === 'browser' && tab.browserPageId ? [tab.browserPageId] : []
  )
  for (const pageId of pageIds) {
    if (suppressedPageIds.size >= MAX_SUPPRESSED_PAGE_IDS) {
      break
    }
    suppressedPageIds.add(pageId)
  }
  if (createdPageId && pageIds.includes(createdPageId) && suppressNextReleasedPageSnapshot) {
    suppressNextReleasedPageSnapshot = false
    releasedPageSnapshotSuppressed = true
    armed = false
    return true
  }
  return pageIds.length > 0
}
