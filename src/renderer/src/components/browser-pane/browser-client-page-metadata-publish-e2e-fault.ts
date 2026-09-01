import { e2eConfig } from '@/lib/e2e-config'

/**
 * Holds a client-hosted page's metadata publish back, so a test can keep the runtime's copy of the
 * page stale for as long as it needs to.
 *
 * Why a fault and not a fixture: in production the publish lands within a round-trip, so the window
 * where the runtime's title disagrees with the guest's is real but sub-second. The renderer's
 * carve-out for pages it hosts exists to cover exactly that window plus a publish that fails
 * outright, and neither can be observed by a test that has to wait for a snapshot to arrive.
 */
type MetadataPublishFaultApi = {
  suppress: () => void
  resume: () => void
  snapshot: () => { suppressed: boolean }
}

type MetadataPublishFaultWindow = Window & {
  __browserClientPageMetadataPublishFault?: MetadataPublishFaultApi
}

let suppressed = false

function exposeFaultApi(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  const target = window as MetadataPublishFaultWindow
  target.__browserClientPageMetadataPublishFault ??= {
    suppress: () => {
      suppressed = true
    },
    resume: () => {
      suppressed = false
    },
    snapshot: () => ({ suppressed })
  }
}

exposeFaultApi()

export function e2eSuppressesBrowserClientPageMetadataPublish(): boolean {
  return e2eConfig.exposeStore && suppressed
}
