import { e2eConfig } from '@/lib/e2e-config'

/** Hold runtime metadata stale deterministically; normal publish lag is sub-second, and snapshot waits would miss both that window and outright failure. */
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
